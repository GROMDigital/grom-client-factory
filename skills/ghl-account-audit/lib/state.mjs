import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256 } from './canonical.mjs';
import { auditPaths } from './paths.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  status TEXT NOT NULL,
  frozen_inputs_json TEXT NOT NULL,
  frozen_inputs_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  location_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, phase)
);
CREATE TABLE IF NOT EXISTS pages (
  run_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, scope_id, page_key)
);`;

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function assertNonEmptyString(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw codedError(code);
}

function assertTimestamp(value, code) {
  if (!Number.isFinite(value)) throw codedError(code);
}

export class AuditState {
  constructor({ paths, locationId }) {
    this.paths = paths;
    this.locationId = locationId;
    mkdirSync(paths.weekly, { recursive: true });
    mkdirSync(paths.memoryEvents, { recursive: true });
    mkdirSync(paths.privateRaw, { recursive: true });
    mkdirSync(paths.privateLogs, { recursive: true });
    mkdirSync(paths.privateCheckpoints, { recursive: true });
    mkdirSync(paths.stateDir, { recursive: true });
    this.db = new DatabaseSync(paths.stateDb);
    this.db.exec(SCHEMA);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }

  #transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original database error is the actionable one.
      }
      throw error;
    }
  }

  createRun({ runId, frozenInputs, now = Date.now() }) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    assertTimestamp(now, 'INVALID_TIMESTAMP');
    if (!frozenInputs || frozenInputs.locationId !== this.locationId) {
      throw codedError('LOCATION_MISMATCH');
    }

    const frozenInputsJson = canonicalJson(frozenInputs);
    const frozenInputsHash = sha256(frozenInputs);
    return this.#transaction(() => {
      const existing = this.db.prepare(
        'SELECT run_id, location_id, status, frozen_inputs_json, frozen_inputs_hash, created_at, updated_at FROM runs WHERE run_id = ?',
      ).get(runId);
      if (existing) {
        if (existing.location_id !== this.locationId || existing.frozen_inputs_hash !== frozenInputsHash) {
          throw codedError('RUN_ID_COLLISION');
        }
        return this.#runRecord(existing);
      }
      this.db.prepare(`
        INSERT INTO runs (run_id, location_id, status, frozen_inputs_json, frozen_inputs_hash, created_at, updated_at)
        VALUES (?, ?, 'running', ?, ?, ?, ?)
      `).run(runId, this.locationId, frozenInputsJson, frozenInputsHash, now, now);
      return {
        runId,
        locationId: this.locationId,
        status: 'running',
        frozenInputs: JSON.parse(frozenInputsJson),
        frozenInputsHash,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  acquireLease({ runId, now, ttlMs }) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    assertTimestamp(now, 'INVALID_TIMESTAMP');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw codedError('INVALID_LEASE_TTL');

    return this.#transaction(() => {
      const lease = this.db.prepare(
        'SELECT run_id, expires_at FROM leases WHERE location_id = ?',
      ).get(this.locationId);
      if (lease && lease.expires_at > now && lease.run_id !== runId) {
        throw codedError('LEASE_HELD');
      }
      const expiresAt = now + ttlMs;
      this.db.prepare(`
        INSERT INTO leases (location_id, run_id, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(location_id) DO UPDATE SET run_id = excluded.run_id, expires_at = excluded.expires_at
      `).run(this.locationId, runId, expiresAt);
      return Object.freeze({ locationId: this.locationId, runId, expiresAt });
    });
  }

  assertResumeInputs(runId, frozenInputs) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    const run = this.db.prepare(
      'SELECT run_id, location_id, status, frozen_inputs_json, frozen_inputs_hash, created_at, updated_at FROM runs WHERE run_id = ?',
    ).get(runId);
    if (!run) throw codedError('RUN_NOT_FOUND');
    if (run.location_id !== this.locationId || sha256(frozenInputs) !== run.frozen_inputs_hash) {
      throw codedError('RESUME_INPUT_MISMATCH');
    }
    return this.#runRecord(run);
  }

  saveCheckpoint({ runId, phase, inputHash, outputHash, payload }) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    assertNonEmptyString(phase, 'INVALID_PHASE');
    assertNonEmptyString(inputHash, 'INVALID_INPUT_HASH');
    assertNonEmptyString(outputHash, 'INVALID_OUTPUT_HASH');
    const payloadJson = canonicalJson(payload);

    return this.#transaction(() => {
      const run = this.db.prepare('SELECT location_id FROM runs WHERE run_id = ?').get(runId);
      if (!run) throw codedError('RUN_NOT_FOUND');
      if (run.location_id !== this.locationId) throw codedError('LOCATION_MISMATCH');

      const existing = this.db.prepare(`
        SELECT run_id, phase, input_hash, output_hash, payload_json
        FROM checkpoints WHERE run_id = ? AND phase = ?
      `).get(runId, phase);
      if (existing) {
        if (
          existing.input_hash !== inputHash
          || existing.output_hash !== outputHash
          || existing.payload_json !== payloadJson
        ) {
          throw codedError('CHECKPOINT_CONFLICT');
        }
        return this.#checkpointRecord(existing);
      }

      this.db.prepare(`
        INSERT INTO checkpoints (run_id, phase, input_hash, output_hash, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, phase, inputHash, outputHash, payloadJson);
      return { runId, phase, inputHash, outputHash, payload: JSON.parse(payloadJson) };
    });
  }

  getCheckpoint({ runId, phase }) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    assertNonEmptyString(phase, 'INVALID_PHASE');
    const checkpoint = this.db.prepare(`
      SELECT run_id, phase, input_hash, output_hash, payload_json
      FROM checkpoints WHERE run_id = ? AND phase = ?
    `).get(runId, phase);
    return checkpoint ? this.#checkpointRecord(checkpoint) : undefined;
  }

  #runRecord(row) {
    return {
      runId: row.run_id,
      locationId: row.location_id,
      status: row.status,
      frozenInputs: JSON.parse(row.frozen_inputs_json),
      frozenInputsHash: row.frozen_inputs_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #checkpointRecord(row) {
    return {
      runId: row.run_id,
      phase: row.phase,
      inputHash: row.input_hash,
      outputHash: row.output_hash,
      payload: JSON.parse(row.payload_json),
    };
  }
}

export function openState({ projectRoot, locationId }) {
  return new AuditState({ paths: auditPaths(projectRoot, locationId), locationId });
}

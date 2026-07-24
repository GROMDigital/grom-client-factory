import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256 } from './canonical.mjs';
import { auditPaths, ensureAuditPaths, verifyAuditDatabasePath } from './paths.mjs';

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

const FROZEN_INPUT_FIELDS = Object.freeze([
  'locationId',
  'target',
  'cutoff',
  'timezone',
  'contextHash',
  'coverageProfileHash',
  'metricProfileHash',
  'rulesetHash',
  'codeHash',
  'auditProfileHash',
  'providerToolProfileHash',
  'windowDefinitionsHash',
  'collectionBudgetHash',
  'capabilityManifestHashes',
  'capabilityProofIndexHash',
  'capabilityReceiptHashes',
  'capabilityAttestationHashes',
  'capabilityProofExpiries',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidFrozenInputs() {
  throw codedError('INVALID_FROZEN_INPUTS');
}

function assertExactFields(value, fields) {
  if (!isPlainObject(value)) invalidFrozenInputs();
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalidFrozenInputs();
}

function assertFrozenString(value) {
  if (typeof value !== 'string' || value.trim().length === 0) invalidFrozenInputs();
}

function assertFrozenHashArray(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    invalidFrozenInputs();
  }
}

function assertFrozenExpiryArray(value) {
  if (!Array.isArray(value) || value.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    invalidFrozenInputs();
  }
}

function validateTarget(target) {
  if (!isPlainObject(target)) invalidFrozenInputs();
  const allowed = target.companyId === undefined
    ? ['targetKind', 'operatingProfile', 'locationId']
    : ['targetKind', 'operatingProfile', 'locationId', 'companyId'];
  assertExactFields(target, allowed);
  if (target.targetKind !== 'location') invalidFrozenInputs();
  if (!['client', 'grom_internal'].includes(target.operatingProfile)) invalidFrozenInputs();
  assertFrozenString(target.locationId);
  if (target.companyId !== undefined) assertFrozenString(target.companyId);
}

function validateFrozenInputs(frozenInputs) {
  try {
    canonicalJson(frozenInputs);
  } catch {
    invalidFrozenInputs();
  }
  assertExactFields(frozenInputs, FROZEN_INPUT_FIELDS);
  assertFrozenString(frozenInputs.locationId);
  validateTarget(frozenInputs.target);
  if (!Number.isSafeInteger(frozenInputs.cutoff) || frozenInputs.cutoff < 0) invalidFrozenInputs();
  assertFrozenString(frozenInputs.timezone);
  try {
    Intl.DateTimeFormat('en', { timeZone: frozenInputs.timezone });
  } catch {
    invalidFrozenInputs();
  }
  for (const field of [
    'contextHash',
    'coverageProfileHash',
    'metricProfileHash',
    'rulesetHash',
    'codeHash',
    'auditProfileHash',
    'providerToolProfileHash',
    'windowDefinitionsHash',
    'collectionBudgetHash',
    'capabilityProofIndexHash',
  ]) assertFrozenString(frozenInputs[field]);
  for (const field of [
    'capabilityManifestHashes',
    'capabilityReceiptHashes',
    'capabilityAttestationHashes',
  ]) assertFrozenHashArray(frozenInputs[field]);
  assertFrozenExpiryArray(frozenInputs.capabilityProofExpiries);
}

export class AuditState {
  constructor({ paths, locationId }) {
    this.paths = paths;
    this.locationId = locationId;
    const auditRoot = ensureAuditPaths(paths);
    this.db = new DatabaseSync(paths.stateDb);
    verifyAuditDatabasePath(paths, auditRoot);
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
    validateFrozenInputs(frozenInputs);
    if (frozenInputs.locationId !== this.locationId || frozenInputs.target.locationId !== this.locationId) {
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
    validateFrozenInputs(frozenInputs);
    const run = this.db.prepare(
      'SELECT run_id, location_id, status, frozen_inputs_json, frozen_inputs_hash, created_at, updated_at FROM runs WHERE run_id = ?',
    ).get(runId);
    if (!run) throw codedError('RUN_NOT_FOUND');
    if (
      run.location_id !== this.locationId
      || frozenInputs.locationId !== this.locationId
      || frozenInputs.target.locationId !== this.locationId
      || sha256(frozenInputs) !== run.frozen_inputs_hash
    ) {
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

  listCheckpoints(runId) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    return this.db.prepare(`
      SELECT run_id, phase, input_hash, output_hash, payload_json
      FROM checkpoints WHERE run_id = ? ORDER BY phase ASC
    `).all(runId).map((checkpoint) => this.#checkpointRecord(checkpoint));
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

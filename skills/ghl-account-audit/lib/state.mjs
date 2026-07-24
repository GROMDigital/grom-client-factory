import { createRequire } from 'node:module';
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
);
CREATE TABLE IF NOT EXISTS review_requests (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('conversation', 'mechanism')),
  request_hash TEXT NOT NULL,
  nonce_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'not_required')),
  request_json TEXT NOT NULL,
  validator_state_json TEXT NOT NULL,
  sealed_relative_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  consumed_at INTEGER,
  response_hash TEXT,
  result_hash TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE TABLE IF NOT EXISTS review_grants (
  request_id TEXT NOT NULL,
  grant_ref TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unread', 'consumed')),
  transcript_availability TEXT,
  PRIMARY KEY (request_id, grant_ref),
  FOREIGN KEY (request_id) REFERENCES review_requests(request_id)
);
CREATE TABLE IF NOT EXISTS review_results (
  request_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (request_id) REFERENCES review_requests(request_id)
);
CREATE TABLE IF NOT EXISTS publication_intents (
  run_id TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  publication_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'published')),
  manifest_hash TEXT,
  publication_root TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, revision_hash),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);`;

let DatabaseSync;

function databaseSyncConstructor() {
  if (DatabaseSync === undefined) {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
  }
  return DatabaseSync;
}

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
  // Task 4 adapter contract: after terminal pagination, sort every authoritative
  // source by sourceId and provide {sourceId, kind, sourceHash}, where sourceHash
  // is sha256({schemaVersion:'1.0.0', source:<canonical source envelope>}).
  // The orchestrator hashes that complete array into privateSourceInventoryHash
  // before createRun. Task 3 collectors may satisfy it but cannot create,
  // expand, substitute, or narrow it.
  'privateSourceInventory',
  'privateSourceInventoryHash',
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

function validatePrivateSourceInventory(inventory, expectedHash) {
  if (!Array.isArray(inventory) || inventory.length === 0) invalidFrozenInputs();
  const sourceIds = new Set();
  let previousSourceId;
  for (const source of inventory) {
    if (
      !isPlainObject(source)
      || Object.keys(source).length !== 3
      || Object.keys(source).some((key) => !['kind', 'sourceHash', 'sourceId'].includes(key))
      || typeof source.sourceId !== 'string'
      || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(source.sourceId)
      || sourceIds.has(source.sourceId)
      || (previousSourceId !== undefined && source.sourceId <= previousSourceId)
      || !['pii', 'credential', 'private-content', 'key-reference'].includes(source.kind)
      || typeof source.sourceHash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(source.sourceHash)
    ) invalidFrozenInputs();
    sourceIds.add(source.sourceId);
    previousSourceId = source.sourceId;
  }
  if (typeof expectedHash !== 'string' || sha256(inventory) !== expectedHash) {
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
  validatePrivateSourceInventory(
    frozenInputs.privateSourceInventory,
    frozenInputs.privateSourceInventoryHash,
  );
}

export class AuditState {
  constructor({ paths, locationId }) {
    this.paths = paths;
    this.locationId = locationId;
    const auditRoot = ensureAuditPaths(paths);
    const Constructor = databaseSyncConstructor();
    this.db = new Constructor(paths.stateDb);
    verifyAuditDatabasePath(paths, auditRoot);
    this.db.exec('PRAGMA foreign_keys = ON');
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

  getRun(runId) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    const run = this.db.prepare(
      'SELECT run_id, location_id, status, frozen_inputs_json, frozen_inputs_hash, created_at, updated_at FROM runs WHERE run_id = ?',
    ).get(runId);
    if (!run) throw codedError('RUN_NOT_FOUND');
    if (run.location_id !== this.locationId) throw codedError('LOCATION_MISMATCH');
    return this.#runRecord(run);
  }

  updateRunStatus({ runId, status, now = Date.now() }) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    assertNonEmptyString(status, 'INVALID_RUN_STATUS');
    assertTimestamp(now, 'INVALID_TIMESTAMP');
    return this.#transaction(() => {
      const changed = this.db.prepare(`
        UPDATE runs SET status = ?, updated_at = ?
        WHERE run_id = ? AND location_id = ?
      `).run(status, now, runId, this.locationId);
      if (changed.changes !== 1) throw codedError('RUN_NOT_FOUND');
      return this.getRun(runId);
    });
  }

  releaseLease({ runId }) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    this.#transaction(() => {
      this.db.prepare(
        'DELETE FROM leases WHERE location_id = ? AND run_id = ?',
      ).run(this.locationId, runId);
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

  saveReviewRequest({
    runId,
    kind,
    request,
    validatorState,
    sealedRelativePath,
    createdAt,
    deadline,
    grants = [],
    notRequired = false,
  }) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    if (!['conversation', 'mechanism'].includes(kind)) {
      throw codedError('REVIEW_REQUEST_STATE_INVALID_KIND', TypeError);
    }
    if (!isPlainObject(request) || !isPlainObject(validatorState)) {
      throw codedError('REVIEW_REQUEST_STATE_INVALID_SHAPE', TypeError);
    }
    const requestId = request.requestId;
    const nonceRef = request.nonceRef ?? request.nonce;
    assertNonEmptyString(requestId, 'REVIEW_REQUEST_STATE_INVALID_ID');
    assertNonEmptyString(nonceRef, 'REVIEW_REQUEST_STATE_INVALID_NONCE');
    if (typeof request.requestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(request.requestHash)) {
      throw codedError('REVIEW_REQUEST_STATE_INVALID_HASH');
    }
    if (
      typeof sealedRelativePath !== 'string'
      || sealedRelativePath.startsWith('/')
      || sealedRelativePath.includes('..')
      || sealedRelativePath.includes('\\')
    ) throw codedError('REVIEW_REQUEST_STATE_INVALID_PATH');
    assertTimestamp(createdAt, 'REVIEW_REQUEST_STATE_INVALID_TIME');
    assertTimestamp(deadline, 'REVIEW_REQUEST_STATE_INVALID_TIME');
    if (deadline < createdAt || !Array.isArray(grants)) {
      throw codedError('REVIEW_REQUEST_STATE_INVALID_TIME');
    }
    const requestJson = canonicalJson(request);
    const validatorStateJson = canonicalJson(validatorState);
    const status = notRequired ? 'not_required' : 'pending';
    return this.#transaction(() => {
      const run = this.db.prepare(
        'SELECT location_id FROM runs WHERE run_id = ?',
      ).get(runId);
      if (!run) throw codedError('RUN_NOT_FOUND');
      if (run.location_id !== this.locationId) throw codedError('LOCATION_MISMATCH');
      const existing = this.db.prepare(
        'SELECT * FROM review_requests WHERE request_id = ?',
      ).get(requestId);
      if (existing) {
        const record = this.#reviewRequestRecord(existing);
        if (
          record.runId !== runId
          || record.kind !== kind
          || record.requestHash !== request.requestHash
          || record.nonceRef !== nonceRef
          || canonicalJson(record.request) !== requestJson
          || canonicalJson(record.validatorState) !== validatorStateJson
          || record.sealedRelativePath !== sealedRelativePath
        ) throw codedError('REVIEW_REQUEST_STATE_INVALID_CONFLICT');
        return record;
      }
      this.db.prepare(`
        INSERT INTO review_requests (
          request_id, run_id, kind, request_hash, nonce_ref, status,
          request_json, validator_state_json, sealed_relative_path,
          created_at, deadline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        runId,
        kind,
        request.requestHash,
        nonceRef,
        status,
        requestJson,
        validatorStateJson,
        sealedRelativePath,
        createdAt,
        deadline,
      );
      const seen = new Set();
      for (const grant of grants) {
        if (
          !isPlainObject(grant)
          || typeof grant.grantRef !== 'string'
          || typeof grant.evidenceRef !== 'string'
          || seen.has(grant.grantRef)
        ) throw codedError('REVIEW_REQUEST_STATE_INVALID_GRANT');
        seen.add(grant.grantRef);
        this.db.prepare(`
          INSERT INTO review_grants (
            request_id, grant_ref, evidence_ref, status, transcript_availability
          ) VALUES (?, ?, ?, 'unread', NULL)
        `).run(requestId, grant.grantRef, grant.evidenceRef);
      }
      return this.getReviewRequest(requestId);
    });
  }

  getReviewRequest(requestId) {
    assertNonEmptyString(requestId, 'REVIEW_REQUEST_STATE_INVALID_ID');
    const row = this.db.prepare(
      'SELECT * FROM review_requests WHERE request_id = ?',
    ).get(requestId);
    if (!row) throw codedError('REVIEW_REQUEST_STATE_INVALID_NOT_FOUND');
    const record = this.#reviewRequestRecord(row);
    const run = this.db.prepare('SELECT location_id FROM runs WHERE run_id = ?').get(record.runId);
    if (!run || run.location_id !== this.locationId) throw codedError('LOCATION_MISMATCH');
    return record;
  }

  listReviewRequests(runId) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    return this.db.prepare(
      'SELECT * FROM review_requests WHERE run_id = ? ORDER BY request_id ASC',
    ).all(runId).map((row) => this.#reviewRequestRecord(row));
  }

  consumeReviewGrant({
    requestId,
    grantRef,
    transcriptAvailability,
  }) {
    if (!['AVAILABLE', 'MISSING', 'EXPIRED'].includes(transcriptAvailability)) {
      throw codedError('REVIEW_REQUEST_STATE_INVALID_GRANT');
    }
    return this.#transaction(() => {
      const request = this.db.prepare(
        'SELECT validator_state_json, status FROM review_requests WHERE request_id = ?',
      ).get(requestId);
      if (!request || request.status !== 'pending') {
        throw codedError('REVIEW_REQUEST_STATE_INVALID_STATUS');
      }
      const changed = this.db.prepare(`
        UPDATE review_grants
        SET status = 'consumed', transcript_availability = ?
        WHERE request_id = ? AND grant_ref = ? AND status = 'unread'
      `).run(transcriptAvailability, requestId, grantRef);
      if (changed.changes !== 1) throw codedError('REVIEW_RESPONSE_REPLAYED_GRANT');
      const validatorState = JSON.parse(request.validator_state_json);
      if (Array.isArray(validatorState.grants)) {
        const grant = validatorState.grants.find((candidate) => candidate.grantRef === grantRef);
        if (!grant || grant.status !== 'UNREAD') {
          throw codedError('REVIEW_REQUEST_STATE_INVALID_GRANT');
        }
        grant.status = 'CONSUMED';
        grant.transcriptAvailability = transcriptAvailability;
        this.db.prepare(`
          UPDATE review_requests SET validator_state_json = ?
          WHERE request_id = ?
        `).run(canonicalJson(validatorState), requestId);
      }
      return this.getReviewRequest(requestId);
    });
  }

  consumeReviewRequest({
    requestId,
    responseHash,
    resultHash,
    result,
    consumedAt,
  }) {
    assertNonEmptyString(requestId, 'REVIEW_REQUEST_STATE_INVALID_ID');
    for (const hash of [responseHash, resultHash]) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) {
        throw codedError('REVIEW_RESPONSE_MISMATCH_HASH');
      }
    }
    assertTimestamp(consumedAt, 'REVIEW_REQUEST_STATE_INVALID_TIME');
    const resultJson = canonicalJson(result);
    if (sha256(result) !== resultHash) throw codedError('REVIEW_RESPONSE_MISMATCH_RESULT');
    return this.#transaction(() => {
      const current = this.db.prepare(
        'SELECT * FROM review_requests WHERE request_id = ?',
      ).get(requestId);
      if (!current) throw codedError('REVIEW_REQUEST_STATE_INVALID_NOT_FOUND');
      if (current.status === 'consumed') throw codedError('REVIEW_RESPONSE_REPLAYED');
      if (current.status !== 'pending') throw codedError('REVIEW_REQUEST_STATE_INVALID_STATUS');
      const changed = this.db.prepare(`
        UPDATE review_requests
        SET status = 'consumed', consumed_at = ?, response_hash = ?, result_hash = ?
        WHERE request_id = ? AND status = 'pending'
      `).run(consumedAt, responseHash, resultHash, requestId);
      if (changed.changes !== 1) throw codedError('REVIEW_RESPONSE_REPLAYED');
      this.db.prepare(`
        INSERT INTO review_results (request_id, result_json, result_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(requestId, resultJson, resultHash, consumedAt);
      return this.getReviewRequest(requestId);
    });
  }

  validateAndConsumeReviewRequest({
    requestId,
    response,
    consumedAt,
    validate,
    checkpoint,
  }) {
    if (typeof validate !== 'function') throw codedError('REVIEW_REQUEST_STATE_INVALID_VALIDATOR');
    const current = this.getReviewRequest(requestId);
    if (current.status === 'consumed') throw codedError('REVIEW_RESPONSE_REPLAYED');
    const result = validate({
      request: current.request,
      response,
      validatorState: current.validatorState,
    });
    const responseHash = sha256(response);
    const resultHash = sha256(result);
    if (checkpoint === undefined) {
      return this.consumeReviewRequest({
        requestId,
        responseHash,
        resultHash,
        result,
        consumedAt,
      });
    }
    if (
      !isPlainObject(checkpoint)
      || checkpoint.runId !== current.runId
      || !/^review-result-(?:conversation|mechanism)$/u.test(checkpoint.phase)
    ) throw codedError('REVIEW_REQUEST_STATE_INVALID_CHECKPOINT');
    const payloadJson = canonicalJson(checkpoint.payload);
    return this.#transaction(() => {
      const row = this.db.prepare(
        'SELECT status FROM review_requests WHERE request_id = ?',
      ).get(requestId);
      if (!row || row.status !== 'pending') throw codedError('REVIEW_RESPONSE_REPLAYED');
      this.db.prepare(`
        UPDATE review_requests
        SET status = 'consumed', consumed_at = ?, response_hash = ?, result_hash = ?
        WHERE request_id = ? AND status = 'pending'
      `).run(consumedAt, responseHash, resultHash, requestId);
      this.db.prepare(`
        INSERT INTO review_results (request_id, result_json, result_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(requestId, canonicalJson(result), resultHash, consumedAt);
      const prior = this.db.prepare(`
        SELECT input_hash, output_hash, payload_json FROM checkpoints
        WHERE run_id = ? AND phase = ?
      `).get(checkpoint.runId, checkpoint.phase);
      if (prior) {
        if (
          prior.input_hash !== checkpoint.inputHash
          || prior.output_hash !== checkpoint.outputHash
          || prior.payload_json !== payloadJson
        ) throw codedError('CHECKPOINT_CONFLICT');
      } else {
        this.db.prepare(`
          INSERT INTO checkpoints (run_id, phase, input_hash, output_hash, payload_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          checkpoint.runId,
          checkpoint.phase,
          checkpoint.inputHash,
          checkpoint.outputHash,
          payloadJson,
        );
      }
      return this.getReviewRequest(requestId);
    });
  }

  preparePublicationIntent({
    runId,
    revisionHash,
    publicationId,
    now = Date.now(),
  }) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    assertNonEmptyString(publicationId, 'PUBLICATION_INTENT_CONFLICT_ID');
    if (typeof revisionHash !== 'string' || !/^[a-f0-9]{64}$/u.test(revisionHash)) {
      throw codedError('PUBLICATION_INTENT_CONFLICT_REVISION');
    }
    assertTimestamp(now, 'INVALID_TIMESTAMP');
    return this.#transaction(() => {
      const run = this.db.prepare(
        'SELECT location_id FROM runs WHERE run_id = ?',
      ).get(runId);
      if (!run) throw codedError('RUN_NOT_FOUND');
      if (run.location_id !== this.locationId) throw codedError('LOCATION_MISMATCH');
      const existing = this.db.prepare(`
        SELECT * FROM publication_intents
        WHERE run_id = ? AND revision_hash = ?
      `).get(runId, revisionHash);
      if (existing) return this.#publicationIntentRecord(existing);
      try {
        this.db.prepare(`
          INSERT INTO publication_intents (
            run_id, revision_hash, publication_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'prepared', ?, ?)
        `).run(runId, revisionHash, publicationId, now, now);
      } catch {
        throw codedError('PUBLICATION_INTENT_CONFLICT_ID');
      }
      return this.getPublicationIntent(runId, revisionHash);
    });
  }

  markPublicationIntentPublished({
    runId,
    revisionHash,
    manifestHash,
    publicationRoot,
    now = Date.now(),
  }) {
    for (const hash of [revisionHash, manifestHash, publicationRoot]) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) {
        throw codedError('PUBLICATION_INTENT_CONFLICT_HASH');
      }
    }
    return this.#transaction(() => {
      const current = this.db.prepare(`
        SELECT * FROM publication_intents
        WHERE run_id = ? AND revision_hash = ?
      `).get(runId, revisionHash);
      if (!current) throw codedError('PUBLICATION_INTENT_CONFLICT_MISSING');
      if (current.status === 'published') {
        if (
          current.manifest_hash !== manifestHash
          || current.publication_root !== publicationRoot
        ) throw codedError('PUBLICATION_INTENT_CONFLICT_PUBLISHED');
        return this.#publicationIntentRecord(current);
      }
      this.db.prepare(`
        UPDATE publication_intents
        SET status = 'published', manifest_hash = ?, publication_root = ?, updated_at = ?
        WHERE run_id = ? AND revision_hash = ? AND status = 'prepared'
      `).run(manifestHash, publicationRoot, now, runId, revisionHash);
      return this.getPublicationIntent(runId, revisionHash);
    });
  }

  getPublicationIntent(runId, revisionHash) {
    const row = this.db.prepare(`
      SELECT * FROM publication_intents
      WHERE run_id = ? AND revision_hash = ?
    `).get(runId, revisionHash);
    if (!row) throw codedError('PUBLICATION_INTENT_CONFLICT_MISSING');
    return this.#publicationIntentRecord(row);
  }

  listPublicationIntents(runId) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    return this.db.prepare(`
      SELECT * FROM publication_intents
      WHERE run_id = ? ORDER BY created_at ASC, revision_hash ASC
    `).all(runId).map((row) => this.#publicationIntentRecord(row));
  }

  getAuthorizedPrivateSourceInventory(runId) {
    assertNonEmptyString(runId, 'INVALID_RUN_ID');
    const run = this.db.prepare(
      'SELECT location_id, frozen_inputs_json, frozen_inputs_hash FROM runs WHERE run_id = ?',
    ).get(runId);
    if (!run) throw codedError('RUN_NOT_FOUND');
    if (run.location_id !== this.locationId) throw codedError('LOCATION_MISMATCH');
    const frozenInputs = JSON.parse(run.frozen_inputs_json);
    validatePrivateSourceInventory(
      frozenInputs.privateSourceInventory,
      frozenInputs.privateSourceInventoryHash,
    );
    return Object.freeze({
      runId,
      frozenInputsHash: run.frozen_inputs_hash,
      sourceInventoryHash: frozenInputs.privateSourceInventoryHash,
      sourceInventory: Object.freeze(frozenInputs.privateSourceInventory.map((source) => (
        Object.freeze({ ...source })
      ))),
    });
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

  #reviewRequestRecord(row) {
    const grants = this.db.prepare(`
      SELECT grant_ref, evidence_ref, status, transcript_availability
      FROM review_grants WHERE request_id = ? ORDER BY grant_ref ASC
    `).all(row.request_id).map((grant) => ({
      grantRef: grant.grant_ref,
      evidenceRef: grant.evidence_ref,
      status: grant.status,
      transcriptAvailability: grant.transcript_availability,
    }));
    const result = this.db.prepare(
      'SELECT result_json FROM review_results WHERE request_id = ?',
    ).get(row.request_id);
    return {
      requestId: row.request_id,
      runId: row.run_id,
      kind: row.kind,
      requestHash: row.request_hash,
      nonceRef: row.nonce_ref,
      status: row.status,
      request: JSON.parse(row.request_json),
      validatorState: JSON.parse(row.validator_state_json),
      sealedRelativePath: row.sealed_relative_path,
      createdAt: row.created_at,
      deadline: row.deadline,
      consumedAt: row.consumed_at,
      responseHash: row.response_hash,
      resultHash: row.result_hash,
      result: result ? JSON.parse(result.result_json) : null,
      grants,
    };
  }

  #publicationIntentRecord(row) {
    return {
      runId: row.run_id,
      revisionHash: row.revision_hash,
      publicationId: row.publication_id,
      status: row.status,
      manifestHash: row.manifest_hash,
      publicationRoot: row.publication_root,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export function openState({ projectRoot, locationId }) {
  return new AuditState({ paths: auditPaths(projectRoot, locationId), locationId });
}

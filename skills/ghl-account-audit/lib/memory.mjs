import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './canonical.mjs';
import { ensureAuditPaths, validateAuditPaths } from './paths.mjs';

const EVENT_TYPES = new Set([
  'finding_observed',
  'finding_transition',
  'approval_receipt',
  'implementation_receipt',
  'verification_result',
  'waiver_recorded',
  'raw_evidence_expired',
]);
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const EVIDENCE_REF = /^ev_[a-f0-9]{16,64}$/u;
const PRIVATE_PATTERN = /(?:https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+\d[\d\s().-]{7,}\d|\b\d{3}[\s().-]\d{3}[\s().-]\d{4}\b)|Bearer\s+\S+|raw_[a-f0-9]{16,64})/iu;

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  if (!Object.isFrozen(value)) throw codedError('MEMORY_EVENT_INVALID_NOT_FROZEN', TypeError);
  seen.add(value);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateSanitized(value, key = '', seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (
      PRIVATE_PATTERN.test(value)
      || /(?:credential|authorization|cookie|secret|password|(?:raw|private).*(?:hash|key))/iu.test(key)
    ) {
      throw codedError('MEMORY_EVENT_INVALID_PRIVATE');
    }
    return;
  }
  if (value === null || ['number', 'boolean'].includes(typeof value)) return;
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw codedError('MEMORY_EVENT_INVALID_VALUE', TypeError);
  }
  seen.add(value);
  try {
    for (const [childKey, child] of Object.entries(value)) {
      validateSanitized(child, childKey, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function legacyRawExpiry(event) {
  return event?.type === 'raw_evidence_expired'
    && typeof event.format === 'string'
    && typeof event.algorithm === 'string'
    && typeof event.expiredAt === 'string'
    && typeof event.rawHash === 'string';
}

function validateEvent(event, { forWrite = false } = {}) {
  assertDeepFrozen(event);
  const legacyExpiry = legacyRawExpiry(event);
  if (forWrite && legacyExpiry) throw codedError('MEMORY_EVENT_INVALID_LEGACY_WRITE');
  const eventTime = legacyExpiry
    ? event.expiredAt
    : event.occurredAt;
  if (
    !plain(event)
    || !EVENT_ID.test(event.eventId ?? '')
    || !EVENT_TYPES.has(event.type)
    || typeof eventTime !== 'string'
    || !Number.isFinite(Date.parse(eventTime))
  ) throw codedError('MEMORY_EVENT_INVALID_SHAPE', TypeError);
  if (!legacyExpiry) validateSanitized(event);
  if (event.type === 'raw_evidence_expired' && !legacyExpiry) {
    const required = [
      'schemaVersion', 'eventId', 'type', 'occurredAt', 'evidenceRefs',
      'expiredEvidenceRefs', 'source', 'retentionClass', 'deletionState',
      'purgeResult', 'provenance',
    ];
    if (
      Object.keys(event).length !== required.length
      || !required.every((key) => Object.hasOwn(event, key))
      || event.schemaVersion !== '1.0.0'
      || !Array.isArray(event.evidenceRefs)
      || !event.evidenceRefs.every((ref) => EVIDENCE_REF.test(ref))
      || !Array.isArray(event.expiredEvidenceRefs)
      || !event.expiredEvidenceRefs.every((ref) => EVIDENCE_REF.test(ref))
      || !['context', 'public_ghl', 'internal_ghl', 'onboarding_portal'].includes(event.source)
      || typeof event.retentionClass !== 'string'
      || event.retentionClass.length === 0
      || event.deletionState !== 'deleted'
      || event.purgeResult !== 'deleted'
      || !plain(event.provenance)
      || Object.keys(event.provenance).sort().join('|') !== [
        'sourceReceiptHash', 'sourceReceiptRef',
      ].sort().join('|')
      || typeof event.provenance.sourceReceiptRef !== 'string'
      || !/^obj_[a-f0-9]{16,64}$/u.test(event.provenance.sourceReceiptRef)
      || !/^[a-f0-9]{64}$/u.test(event.provenance.sourceReceiptHash ?? '')
    ) throw codedError('MEMORY_EVENT_INVALID_RAW_EXPIRY_SCHEMA');
  }
  if (event.type !== 'raw_evidence_expired') {
    if (typeof event.findingId !== 'string' || event.findingId.length === 0) {
      throw codedError('MEMORY_EVENT_INVALID_FINDING');
    }
  }
  if (
    Array.isArray(event.evidenceRefs)
    && !event.evidenceRefs.every((ref) => EVIDENCE_REF.test(ref))
  ) throw codedError('MEMORY_EVENT_INVALID_EVIDENCE');
  if (
    ['approval_receipt', 'implementation_receipt', 'verification_result'].includes(event.type)
    && (
      typeof event.solutionId !== 'string'
      || !/^[a-z][a-z0-9_]{2,127}$/u.test(event.solutionId)
      || typeof event.proposalHash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(event.proposalHash)
    )
  ) throw codedError('MEMORY_EVENT_INVALID_RECEIPT');
  return event;
}

function route(event) {
  if (event.type === 'approval_receipt') return 'approval-receipts';
  if (event.type === 'implementation_receipt') return 'implementation-receipts';
  return '';
}

function ensureCanonicalDirectory(paths, subdirectory) {
  const base = paths.memoryEvents;
  const target = subdirectory ? join(base, subdirectory) : base;
  const fromBase = relative(base, target);
  if (
    fromBase.startsWith(`..${sep}`)
    || fromBase === '..'
    || basename(target) !== (subdirectory || basename(base))
  ) throw codedError('MEMORY_EVENT_INVALID_PATH');
  if (subdirectory) {
    if (!existsSync(target)) mkdirSync(target, { mode: 0o700 });
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw codedError('MEMORY_EVENT_INVALID_PATH');
    }
  }
  return target;
}

export function appendMemoryEvent({ paths: suppliedPaths, event } = {}) {
  try {
    const paths = validateAuditPaths(suppliedPaths);
    validateEvent(event, { forWrite: true });
    ensureAuditPaths(paths);
    const directory = ensureCanonicalDirectory(paths, route(event));
    const finalPath = join(directory, `${event.eventId}.json`);
    const bytes = Buffer.from(`${canonicalJson(event)}\n`, 'utf8');
    if (existsSync(finalPath)) {
      const metadata = lstatSync(finalPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw codedError('MEMORY_EVENT_CONFLICT');
      }
      if (readFileSync(finalPath).equals(bytes)) {
        return deepFreeze({ path: finalPath, eventHash: sha256(event), recovered: true });
      }
      throw codedError('MEMORY_EVENT_CONFLICT');
    }
    const temporary = join(directory, `.${event.eventId}.${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(temporary, finalPath);
      chmodSync(finalPath, 0o400);
      const directoryDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      rmSync(temporary, { force: true });
      return deepFreeze({ path: finalPath, eventHash: sha256(event), recovered: false });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
      if (error?.code === 'EEXIST' && existsSync(finalPath)) {
        if (readFileSync(finalPath).equals(bytes)) {
          return deepFreeze({ path: finalPath, eventHash: sha256(event), recovered: true });
        }
        throw codedError('MEMORY_EVENT_CONFLICT');
      }
      if (typeof error?.code === 'string' && error.code.startsWith('MEMORY_')) throw error;
      throw codedError('MEMORY_EVENT_WRITE_FAILED');
    }
  } catch (error) {
    if (typeof error?.code === 'string' && (
      error.code.startsWith('MEMORY_')
      || error.code.startsWith('AUDIT_')
    )) throw error;
    throw codedError('MEMORY_EVENT_INVALID', TypeError);
  }
}

function orderedEvents(events) {
  if (!Array.isArray(events)) throw codedError('BACKLOG_EVENT_SEQUENCE_INVALID_INPUT', TypeError);
  assertDeepFrozen(events);
  for (const event of events) validateEvent(event);
  const ordered = [...events].sort((left, right) => (
    Date.parse(legacyRawExpiry(left) ? left.expiredAt : left.occurredAt)
      - Date.parse(legacyRawExpiry(right) ? right.expiredAt : right.occurredAt)
      || left.eventId.localeCompare(right.eventId)
  ));
  const ids = new Set();
  for (const event of ordered) {
    if (ids.has(event.eventId)) throw codedError('BACKLOG_EVENT_SEQUENCE_INVALID_DUPLICATE');
    ids.add(event.eventId);
  }
  return ordered;
}

function newEntry(event) {
  return {
    findingId: event.findingId,
    findingFingerprint: event.findingFingerprint,
    findingAliases: [event.findingId],
    status: 'OBSERVED',
    evidenceRefs: [...new Set(event.evidenceRefs ?? [])].sort(),
    proposalHash: event.proposalHash ?? null,
    proposalApproved: false,
    solutionId: null,
    deviations: [],
    waiver: null,
    lastEventAt: event.occurredAt,
    lastEventId: event.eventId,
    history: [{
      eventId: event.eventId,
      type: event.type,
      occurredAt: event.occurredAt,
    }],
  };
}

function requireEntry(entries, aliases, event) {
  const fingerprint = aliases.get(event.findingId) ?? event.findingFingerprint;
  const entry = entries.get(fingerprint);
  if (!entry) throw codedError('BACKLOG_EVENT_SEQUENCE_INVALID_MISSING_FINDING');
  return entry;
}

function applyEvent(entries, aliases, event) {
  if (event.type === 'raw_evidence_expired') return;
  if (event.type === 'finding_observed') {
    const prior = entries.get(event.findingFingerprint);
    if (!prior) {
      entries.set(event.findingFingerprint, newEntry(event));
      aliases.set(event.findingId, event.findingFingerprint);
      return;
    }
    aliases.set(event.findingId, event.findingFingerprint);
    prior.findingAliases = [...new Set([...prior.findingAliases, event.findingId])];
    const newRefs = [...new Set(event.evidenceRefs ?? [])].sort();
    if (
      prior.status === 'REJECTED'
      && event.materiallyNewEvidence !== true
      && canonicalJson(newRefs) !== canonicalJson(prior.evidenceRefs)
    ) throw codedError('BACKLOG_EVENT_SEQUENCE_INVALID_REOPEN');
    if (event.proposalHash !== undefined && event.proposalHash !== prior.proposalHash) {
      prior.proposalApproved = false;
      prior.proposalHash = event.proposalHash;
    }
    if (prior.status !== 'REJECTED' || event.materiallyNewEvidence === true) {
      prior.status = 'OBSERVED';
    }
    prior.evidenceRefs = newRefs;
  } else if (event.type === 'finding_transition') {
    const entry = requireEntry(entries, aliases, event);
    if (event.transition === 'RESOLVED' && (event.evidenceRefs ?? []).length === 0) {
      throw codedError('BACKLOG_EVENT_SEQUENCE_INVALID_RESOLUTION');
    }
    entry.status = event.transition;
    if (Array.isArray(event.evidenceRefs) && event.evidenceRefs.length > 0) {
      entry.evidenceRefs = [...new Set(event.evidenceRefs)].sort();
    }
  } else if (event.type === 'approval_receipt') {
    const entry = requireEntry(entries, aliases, event);
    entry.proposalApproved = event.proposalHash === entry.proposalHash;
    entry.solutionId = event.solutionId;
  } else if (event.type === 'implementation_receipt') {
    const entry = requireEntry(entries, aliases, event);
    if (event.proposalHash === entry.proposalHash) {
      entry.status = 'IMPLEMENTED_UNVERIFIED';
      entry.solutionId = event.solutionId;
      entry.deviations = [...(event.deviations ?? [])].sort();
      entry.implementationAt = event.occurredAt;
    }
  } else if (event.type === 'verification_result') {
    const entry = requireEntry(entries, aliases, event);
    const receipt = event.rereadReceipt;
    if (
      !plain(receipt)
      || Object.keys(receipt).sort().join('|') !== [
        'capturedAt', 'evidenceCutoff', 'evidenceRefs', 'independent',
        'payloadHash', 'proposalHash', 'receiptId', 'source',
      ].sort().join('|')
      || receipt.independent !== true
      || !['public_ghl', 'internal_ghl', 'onboarding_portal'].includes(receipt.source)
      || !Number.isFinite(Date.parse(receipt.capturedAt))
      || !Number.isFinite(Date.parse(receipt.evidenceCutoff))
      || Date.parse(receipt.capturedAt) < Date.parse(entry.implementationAt ?? '')
      || !/^[a-f0-9]{64}$/u.test(receipt.payloadHash ?? '')
      || receipt.proposalHash !== event.proposalHash
      || !Array.isArray(receipt.evidenceRefs)
      || receipt.evidenceRefs.length === 0
      || receipt.evidenceRefs.some((ref) => !EVIDENCE_REF.test(ref))
      || canonicalJson(receipt.evidenceRefs) !== canonicalJson(event.evidenceRefs ?? [])
    ) throw codedError('BACKLOG_EVENT_SEQUENCE_INVALID_REREAD_PROVENANCE');
    if (
      entry.status === 'IMPLEMENTED_UNVERIFIED'
      && event.proposalHash === entry.proposalHash
      && event.solutionId === entry.solutionId
      && event.result === 'PASS'
      && (event.deviations ?? []).length === 0
    ) {
      entry.status = 'VERIFIED';
    } else if (entry.status === 'IMPLEMENTED_UNVERIFIED') {
      entry.deviations = [...new Set([
        ...entry.deviations,
        ...(event.deviations ?? []),
      ])].sort();
    }
  } else if (event.type === 'waiver_recorded') {
    const entry = requireEntry(entries, aliases, event);
    entry.status = 'WAIVED';
    entry.waiver = event.reasonCode ?? 'WAIVER_RECORDED';
  }
  const entry = requireEntry(entries, aliases, event);
  entry.lastEventAt = event.occurredAt;
  entry.lastEventId = event.eventId;
  entry.history.push({
    eventId: event.eventId,
    type: event.type,
    occurredAt: event.occurredAt,
  });
}

function renderBacklog(entries) {
  const lines = ['# Backlog', ''];
  if (entries.length === 0) return `${lines.join('\n')}No open findings.\n`;
  for (const entry of entries) {
    lines.push(`## ${entry.findingId}`, '');
    lines.push(`- Status: ${entry.status}`);
    lines.push(`- Fingerprint: ${entry.findingFingerprint ?? 'unknown'}`);
    lines.push(`- Evidence: ${entry.evidenceRefs.join(', ') || 'none'}`);
    lines.push(`- Proposal approval current: ${entry.proposalApproved ? 'yes' : 'no'}`);
    if (entry.deviations.length > 0) lines.push(`- Deviations: ${entry.deviations.join(', ')}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function projectBacklog({ events } = {}) {
  const entries = new Map();
  const aliases = new Map();
  const ordered = orderedEvents(events);
  for (const event of ordered) applyEvent(entries, aliases, event);
  const projected = [...entries.values()]
    .map((entry) => ({
      ...entry,
      evidenceRefs: [...entry.evidenceRefs],
      deviations: [...entry.deviations],
      findingAliases: [...entry.findingAliases].sort(),
      history: [...entry.history],
    }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
  const json = {
    schemaVersion: '1.0.0',
    eventCount: ordered.length,
    entries: projected,
  };
  return deepFreeze({ json, markdown: renderBacklog(projected) });
}

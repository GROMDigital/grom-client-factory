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
const PRIVATE_PATTERN = /(?:https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|Bearer\s+\S+|raw_[a-f0-9]{16,64})/iu;

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
    if (PRIVATE_PATTERN.test(value) || /(?:credential|authorization|cookie|secret|password)/iu.test(key)) {
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

function validateEvent(event) {
  assertDeepFrozen(event);
  const eventTime = event.type === 'raw_evidence_expired'
    ? event.expiredAt
    : event.occurredAt;
  if (
    !plain(event)
    || !EVENT_ID.test(event.eventId ?? '')
    || !EVENT_TYPES.has(event.type)
    || typeof eventTime !== 'string'
    || !Number.isFinite(Date.parse(eventTime))
  ) throw codedError('MEMORY_EVENT_INVALID_SHAPE', TypeError);
  if (event.type !== 'raw_evidence_expired') validateSanitized(event);
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
    validateEvent(event);
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
    Date.parse(left.type === 'raw_evidence_expired' ? left.expiredAt : left.occurredAt)
      - Date.parse(right.type === 'raw_evidence_expired' ? right.expiredAt : right.occurredAt)
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
    status: 'OBSERVED',
    evidenceRefs: [...new Set(event.evidenceRefs ?? [])].sort(),
    proposalHash: event.proposalHash ?? null,
    proposalApproved: false,
    solutionId: null,
    deviations: [],
    waiver: null,
    lastEventAt: event.occurredAt,
    lastEventId: event.eventId,
  };
}

function requireEntry(entries, event) {
  const entry = entries.get(event.findingId);
  if (!entry) throw codedError('BACKLOG_EVENT_SEQUENCE_INVALID_MISSING_FINDING');
  return entry;
}

function applyEvent(entries, event) {
  if (event.type === 'raw_evidence_expired') return;
  if (event.type === 'finding_observed') {
    const prior = entries.get(event.findingId);
    if (!prior) {
      entries.set(event.findingId, newEntry(event));
      return;
    }
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
    const entry = requireEntry(entries, event);
    if (event.transition === 'RESOLVED' && (event.evidenceRefs ?? []).length === 0) {
      throw codedError('BACKLOG_EVENT_SEQUENCE_INVALID_RESOLUTION');
    }
    entry.status = event.transition;
    if (Array.isArray(event.evidenceRefs) && event.evidenceRefs.length > 0) {
      entry.evidenceRefs = [...new Set(event.evidenceRefs)].sort();
    }
  } else if (event.type === 'approval_receipt') {
    const entry = requireEntry(entries, event);
    entry.proposalApproved = event.proposalHash === entry.proposalHash;
    entry.solutionId = event.solutionId;
  } else if (event.type === 'implementation_receipt') {
    const entry = requireEntry(entries, event);
    if (event.proposalHash === entry.proposalHash) {
      entry.status = 'IMPLEMENTED_UNVERIFIED';
      entry.solutionId = event.solutionId;
      entry.deviations = [...(event.deviations ?? [])].sort();
    }
  } else if (event.type === 'verification_result') {
    const entry = requireEntry(entries, event);
    if (
      entry.status === 'IMPLEMENTED_UNVERIFIED'
      && event.proposalHash === entry.proposalHash
      && event.solutionId === entry.solutionId
      && event.liveReread === true
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
    const entry = requireEntry(entries, event);
    entry.status = 'WAIVED';
    entry.waiver = event.reasonCode ?? 'WAIVER_RECORDED';
  }
  const entry = entries.get(event.findingId);
  entry.lastEventAt = event.occurredAt;
  entry.lastEventId = event.eventId;
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
  const ordered = orderedEvents(events);
  for (const event of ordered) applyEvent(entries, event);
  const projected = [...entries.values()]
    .map((entry) => ({
      ...entry,
      evidenceRefs: [...entry.evidenceRefs],
      deviations: [...entry.deviations],
    }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
  const json = {
    schemaVersion: '1.0.0',
    eventCount: ordered.length,
    entries: projected,
  };
  return deepFreeze({ json, markdown: renderBacklog(projected) });
}

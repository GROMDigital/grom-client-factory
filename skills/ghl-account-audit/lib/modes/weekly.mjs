import {
  mkdirSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { canonicalJson, sha256 } from '../canonical.mjs';

const INTERNAL_LIMITATIONS = Object.freeze([
  'INTERNAL_WORKFLOW_DEFINITION_MISSING',
  'INTERNAL_WORKFLOW_RUNTIME_MISSING',
]);
const FORBIDDEN_MOVEMENT = new Set(['IMPROVING', 'REGRESSED', 'RESOLVED']);
const BROAD_REPORT_LANGUAGE = /(?:account[- ]wide|whole[- ]account|all systems passed|total (?:account )?impact|top leak across)/iu;

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function iso(value, code = 'AUDIT_COMMAND_INVALID_TIME') {
  try {
    return Temporal.Instant.from(value).toString({ smallestUnit: 'millisecond' });
  } catch {
    throw codedError(code, TypeError);
  }
}

function daysBetween(from, to) {
  const milliseconds = Temporal.Instant.from(to).epochMilliseconds
    - Temporal.Instant.from(from).epochMilliseconds;
  return Math.max(0, Math.ceil(milliseconds / 86_400_000));
}

function subtractHours(value, hours) {
  return Temporal.Instant.from(value).subtract({ hours }).toString({
    smallestUnit: 'millisecond',
  });
}

export function planWeeklyCollection({
  cutoff,
  timezone,
  salesCycleDays,
  providerAvailableFrom,
  priorWatermark,
  lateArrivalHours = 72,
} = {}) {
  const normalizedCutoff = iso(cutoff);
  try {
    Temporal.Now.zonedDateTimeISO(timezone);
  } catch {
    throw codedError('AUDIT_COMMAND_INVALID_TIMEZONE', TypeError);
  }
  if (priorWatermark !== undefined) {
    const overlapHours = Math.max(72, Number.isFinite(lateArrivalHours) ? lateArrivalHours : 72);
    return deepFreeze({
      mode: 'later',
      cutoff: normalizedCutoff,
      timezone,
      overlapHours,
      priorWatermark: iso(priorWatermark),
      collectionStart: subtractHours(priorWatermark, overlapHours),
      requestedHistoryDays: null,
      appliedHistoryDays: null,
      limitations: [],
    });
  }
  const cycleDays = Number.isFinite(salesCycleDays) && salesCycleDays > 0
    ? Math.ceil(salesCycleDays) * 2
    : 0;
  const requestedHistoryDays = Math.max(90, cycleDays);
  const requestedFrom = Temporal.Instant.from(normalizedCutoff)
    .subtract({ hours: requestedHistoryDays * 24 })
    .toString({ smallestUnit: 'millisecond' });
  const availableFrom = providerAvailableFrom === undefined
    ? requestedFrom
    : iso(providerAvailableFrom);
  const collectionStart = Temporal.Instant.compare(
    Temporal.Instant.from(availableFrom),
    Temporal.Instant.from(requestedFrom),
  ) > 0 ? availableFrom : requestedFrom;
  const appliedHistoryDays = daysBetween(collectionStart, normalizedCutoff);
  const limitations = appliedHistoryDays < requestedHistoryDays
    ? ['PROVIDER_HISTORY_SHORTER_THAN_REQUESTED']
    : [];
  return deepFreeze({
    mode: 'first',
    cutoff: normalizedCutoff,
    timezone,
    requestedHistoryDays,
    appliedHistoryDays,
    requestedFrom,
    providerAvailableFrom: availableFrom,
    collectionStart,
    limitations,
  });
}

function sanitizeFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return finding;
  const next = structuredClone(finding);
  if (next.scope === 'account_wide') next.scope = 'public_comparable_subset';
  if (next.impact !== undefined) next.impact = null;
  if (next.totalImpact !== undefined) next.totalImpact = null;
  if (next.verdict === 'PASS') next.verdict = 'UNKNOWN';
  return next;
}

function isUnmeasuredValue(value) {
  if (value === null || value === 'UNMEASURED' || value === 'UNKNOWN') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== 'object') return false;
  const state = value.kind ?? value.state;
  return ['UNKNOWN', 'UNMEASURED', 'NOT_AVAILABLE'].includes(state)
    && Object.entries(value).every(([key, child]) => (
      ['kind', 'state', 'reasonCode', 'limitationCode'].includes(key)
      || child === null
      || child === 'UNKNOWN'
      || child === 'UNMEASURED'
    ));
}

function assertNoPublicOnlyOverclaim(value, path = [], seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoPublicOnlyOverclaim(
      child,
      [...path, String(index)],
      seen,
    ));
  } else {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '');
      if (
        ['scope', 'coveragescope'].includes(normalized)
        && typeof child === 'string'
        && /account.?wide|whole.?account/iu.test(child)
      ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
      if (
        (normalized === 'verdict' || path.includes('verdicts'))
        && child === 'PASS'
      ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
      if (
        /(?:impact|commercialvalue|revenuepromise)/u.test(normalized)
        && !isUnmeasuredValue(child)
      ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
      assertNoPublicOnlyOverclaim(child, [...path, key], seen);
    }
  }
  seen.delete(value);
}

export function enforcePublicOnlyPublication(input = {}, { firstBaseline = false } = {}) {
  if (input?.payloadArtifacts && input?.projections && input?.manifestInput) {
    const coverage = input.payloadArtifacts['coverage.json'];
    const machine = input.payloadArtifacts['metrics-and-findings.json'];
    const limitations = Array.isArray(coverage?.limitations)
      ? new Set(coverage.limitations)
      : new Set();
    if (
      input.manifestInput.status !== 'complete_partial'
      || coverage?.state !== 'complete_partial'
      || machine?.sealedInputs?.run?.status !== 'complete_partial'
      || !limitations.has('INTERNAL_WORKFLOW_DEFINITION_MISSING')
      || !limitations.has('INTERNAL_WORKFLOW_RUNTIME_MISSING')
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
    for (const artifact of Object.values(input.payloadArtifacts)) {
      if (artifact && typeof artifact === 'object') {
        assertNoPublicOnlyOverclaim(artifact);
      }
    }
    assertNoPublicOnlyOverclaim(input.projections);
    if (
      typeof input.payloadArtifacts['REPORT.md'] !== 'string'
      || BROAD_REPORT_LANGUAGE.test(input.payloadArtifacts['REPORT.md'])
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLIC_SCOPE');
    const serialized = canonicalJson(input.payloadArtifacts);
    if (
      firstBaseline
      && [...FORBIDDEN_MOVEMENT].some((label) => serialized.includes(`"${label}"`))
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_FIRST_BASELINE_MOVEMENT');
    return deepFreeze({ ...structuredClone(input), status: 'complete_partial' });
  }
  const coverage = input.coverage && typeof input.coverage === 'object'
    ? structuredClone(input.coverage)
    : {};
  coverage.state = 'complete_partial';
  coverage.scope = 'public_comparable_subset';
  coverage.limitations = [...new Set([
    ...(Array.isArray(coverage.limitations) ? coverage.limitations : []),
    ...INTERNAL_LIMITATIONS,
  ])].sort();
  const diff = input.diff && typeof input.diff === 'object'
    ? structuredClone(input.diff)
    : { state: 'FIRST_BASELINE', transitions: [] };
  if (Array.isArray(diff.transitions) && firstBaseline) {
    diff.transitions = diff.transitions.filter((transition) => (
      !FORBIDDEN_MOVEMENT.has(transition?.state ?? transition)
    ));
  }
  if (firstBaseline && FORBIDDEN_MOVEMENT.has(diff.state)) diff.state = 'NOT_COMPARABLE';
  return deepFreeze({
    ...structuredClone(input),
    status: 'complete_partial',
    coverage,
    diff,
    findings: Array.isArray(input.findings) ? input.findings.map(sanitizeFinding) : [],
    latestFull: input.latestFull ?? null,
  });
}

function safeFixturePath(root, candidate, code) {
  const resolvedRoot = realpathSync(root);
  const resolvedCandidate = realpathSync(candidate);
  if (
    resolvedCandidate !== resolvedRoot
    && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  ) throw codedError(code);
  return resolvedCandidate;
}

function writeReplayArtifact(pathname, bytes) {
  if (existsSync(pathname)) {
    const metadata = lstatSync(pathname);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || !readFileSync(pathname).equals(bytes)
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_REPLAY_CONFLICT');
    return;
  }
  writeFileSync(pathname, bytes, { mode: 0o400, flag: 'wx' });
}

export function replayWeeklyFixture({ fixtureRoot, outputRoot }) {
  if (typeof fixtureRoot !== 'string' || typeof outputRoot !== 'string') {
    throw codedError('AUDIT_COMMAND_INVALID_REPLAY', TypeError);
  }
  const fixtureDir = safeFixturePath(fixtureRoot, fixtureRoot, 'AUDIT_COMMAND_INVALID_FIXTURE');
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(join(fixtureDir, 'fixture.json'), 'utf8'));
  } catch {
    throw codedError('AUDIT_COMMAND_INVALID_FIXTURE');
  }
  if (
    fixture?.schemaVersion !== '1.0.0'
    || !Array.isArray(fixture.pages)
    || typeof fixture.locationId !== 'string'
  ) throw codedError('AUDIT_COMMAND_INVALID_FIXTURE');
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const canonicalOutput = realpathSync(outputRoot);
  const events = [];
  for (const page of fixture.pages) {
    if (!Array.isArray(page.events)) throw codedError('AUDIT_COMMAND_INVALID_FIXTURE');
    events.push(...page.events);
  }
  const byId = new Map();
  for (const event of events) {
    if (typeof event.nativeEventId !== 'string') throw codedError('AUDIT_COMMAND_INVALID_FIXTURE');
    const existing = byId.get(event.nativeEventId);
    if (existing && canonicalJson(existing) !== canonicalJson(event)) {
      throw codedError('AUDIT_INTEGRITY_FAILURE_EVENT_CONFLICT');
    }
    byId.set(event.nativeEventId, event);
  }
  const safeEvents = [...byId.values()]
    .map(({ nativeEventId, occurredAt, kind }) => ({ nativeEventId, occurredAt, kind }))
    .sort((left, right) => left.nativeEventId.localeCompare(right.nativeEventId));
  const publicationId = `fixture_${sha256({
    locationId: fixture.locationId,
    cutoff: fixture.cutoff,
    events: safeEvents,
  }).slice(0, 20)}`;
  const week = '2026-W29';
  const relativePublication = join('weekly', week, publicationId);
  const publicationRoot = resolve(canonicalOutput, relativePublication);
  if (!publicationRoot.startsWith(`${canonicalOutput}${sep}`)) {
    throw codedError('AUDIT_COMMAND_INVALID_OUTPUT');
  }
  mkdirSync(publicationRoot, { recursive: true, mode: 0o700 });
  const plan = planWeeklyCollection({
    cutoff: fixture.cutoff,
    timezone: fixture.timezone,
    salesCycleDays: fixture.salesCycleDays,
    providerAvailableFrom: fixture.providerAppliedFrom,
  });
  const coverage = {
    schemaVersion: '1.0.0',
    state: 'complete_partial',
    scope: 'public_comparable_subset',
    limitations: [
      ...INTERNAL_LIMITATIONS,
      ...plan.limitations,
    ].sort(),
  };
  const report = [
    '# Weekly GHL audit replay',
    '',
    'Status: complete_partial',
    'Scope: public comparable subset',
    '',
    'Internal workflow definitions and runtime logs were not available.',
    '',
  ].join('\n');
  writeReplayArtifact(join(publicationRoot, 'REPORT.md'), Buffer.from(report, 'utf8'));
  writeReplayArtifact(
    join(publicationRoot, 'coverage.json'),
    Buffer.from(`${canonicalJson(coverage)}\n`, 'utf8'),
  );
  writeReplayArtifact(
    join(publicationRoot, 'replay-summary.json'),
    Buffer.from(`${canonicalJson({
      schemaVersion: '1.0.0',
      eventCount: safeEvents.length,
      requestedHistoryDays: plan.requestedHistoryDays,
      appliedHistoryDays: plan.appliedHistoryDays,
    })}\n`, 'utf8'),
  );
  return deepFreeze({
    status: 'complete_partial',
    publicationId,
    publicationPath: relative(canonicalOutput, publicationRoot).split(sep).join('/'),
  });
}

export const WEEKLY_INTERNAL_LIMITATIONS = INTERNAL_LIMITATIONS;

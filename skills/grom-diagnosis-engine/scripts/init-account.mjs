#!/usr/bin/env node
/**
 * SET UP A NEW ACCOUNT FOR THE DIAGNOSIS ENGINE, IN ONE COMMAND.
 *
 * Replaces the copy-and-hand-edit `build-config.mjs` that every account used to need. That file was
 * duplicated per account, carried an ABSOLUTE path to the skill, and required three facts about the
 * account to be looked up by hand. Looking them up by hand is the part that actually bit: SK Skin is
 * a Melbourne clinic whose account timezone is Australia/Sydney, and using the city instead of the
 * account's own declared value would have shifted every weekly window boundary silently.
 *
 * So the three facts are READ FROM THE ACCOUNT, not typed:
 *   companyId   the agency the location belongs to; the internal rail needs it
 *   timezone    the account's own, which decides where a week starts
 *   currency    what the money in the report is denominated in
 *
 * Everything else is derived from shipped artefacts exactly as before, and the config it writes is
 * byte-identical in shape to the hand-written ones. This script makes exactly ONE network call, a
 * read of the location record, and never touches anything else in the account.
 *
 * Usage:
 *   node scripts/init-account.mjs \
 *     --project ~/.grom-audit-runs/<label> \
 *     --location <locationId> \
 *     --label <slug> \
 *     --credential-env <ENV_VAR_NAME> \
 *     [--profile client|grom_internal] [--cutoff <epoch-ms>] [--worker <url>]
 *     [--note "..."] [--currency AUD|GBP|...] [--token-file <path to the internal-rail token>]
 *
 * The credential is read from the named environment variable and is never written to disk, printed,
 * or stored in the config: the config records only the NAME of the variable to read at run time.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WORKER = 'https://ghl-mcp-server.xanderjohnrazonroque.workers.dev/mcp';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (typeof key !== 'string' || !key.startsWith('--') || typeof value !== 'string') {
      throw new Error(`INIT_BAD_ARGUMENTS near ${JSON.stringify(key)}`);
    }
    flags[key.slice(2)] = value;
  }
  for (const required of ['project', 'location', 'label', 'credential-env']) {
    if (!flags[required]) throw new Error(`INIT_MISSING_FLAG --${required}`);
  }
  if (!/^[A-Za-z0-9][-A-Za-z0-9_.]{0,127}$/u.test(flags.location)) throw new Error('INIT_BAD_LOCATION');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(flags.label)) throw new Error('INIT_BAD_LABEL');
  return flags;
}

/**
 * ONE READ, over the same worker the run itself uses.
 *
 * Hand-rolled rather than routed through the adapter because this runs BEFORE a config exists, and
 * the adapter's whole job is to enforce a config. The streamable-HTTP handshake is required: the
 * worker refuses a tools/call without a session, which is worth stating because a bare POST answers
 * with a confusing "Mcp-Session-Id header is required" and looks like an auth failure.
 */
async function readLocation({ worker, token, locationId }) {
  const headers = {
    'X-GHL-Token': token,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const post = (body, extra = {}) => fetch(worker, {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });

  const opened = await post({
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'init-account', version: '1' } },
  });
  const session = opened.headers.get('mcp-session-id');
  if (!session) throw new Error('INIT_NO_MCP_SESSION');
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'Mcp-Session-Id': session });

  const answered = await post({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'execute_action',
      arguments: { action_id: 'locations__get-location', params: { locationId } },
    },
  }, { 'Mcp-Session-Id': session });

  // The worker answers as SSE: the JSON payload is spread over `data: ` lines.
  const text = await answered.text();
  const payload = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('');
  const envelope = JSON.parse(payload || text);
  const body = JSON.parse(envelope.result.content[0].text);
  if (body.ok !== true) throw new Error(`INIT_LOCATION_READ_FAILED ${body.error ?? 'unknown'}`);
  // `data` is a JSON string, and the worker may append a human note after it when it truncates.
  const raw = typeof body.data === 'string' ? body.data : JSON.stringify(body.data);
  const cut = raw.indexOf('\n\n... showing');
  const record = JSON.parse(cut > 0 ? raw.slice(0, cut) : raw);
  return record.location ?? record;
}

/**
 * The real instant of local midnight on a given calendar day in a given zone.
 *
 * There is no direct API for this. The reliable construction is to guess the UTC instant for those
 * wall-clock numbers, read that instant BACK in the target zone, and correct by however far it
 * drifted. Doing it any other way means hardcoding an offset, which is wrong twice a year in every
 * zone that observes daylight saving, and a window boundary that is an hour out silently moves
 * records between weeks.
 */
function zonedMidnight(timezone, year, month, day) {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess));
  const at = (type) => Number(parts.find((p) => p.type === type).value);
  const readBack = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second'));
  return guess - (readBack - guess);
}

/** Monday 00:00 in the ACCOUNT's timezone, most recently past. A week must close before it is read. */
function lastMondayMidnight(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const at = (type) => parts.find((p) => p.type === type).value;
  const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(at('weekday'));
  if (index === -1) throw new Error('INIT_WEEKDAY_UNREADABLE');
  const todayMidnight = zonedMidnight(timezone, Number(at('year')), Number(at('month')), Number(at('day')));
  // On a Monday the week that just closed started SEVEN days ago, not zero.
  return todayMidnight - (index === 0 ? 7 : index) * 86_400_000;
}

const flags = parseArgs(process.argv.slice(2));
const profileId = flags.profile ?? 'client';
const worker = flags.worker ?? DEFAULT_WORKER;
const projectRoot = resolve(flags.project.replace(/^~/u, process.env.HOME ?? '~'));
const token = process.env[flags['credential-env']];
if (!token) throw new Error(`INIT_CREDENTIAL_NOT_SET ${flags['credential-env']} is empty or unset`);

const { sha256 } = await import(join(SKILL, 'lib/canonical.mjs'));
const { loadTrustedPublicReadPolicy } = await import(join(SKILL, 'lib/adapters/trusted-public-policy.mjs'));
const { translatedActionIds } = await import(join(SKILL, 'lib/adapters/ghl-public-translator.mjs'));
const { WINDOW_NAMES, DEFAULT_REPORTING_WINDOWS } = await import(join(SKILL, 'lib/window-names.mjs'));
const { loadCollectionBudgets, loadProfile } = await import(join(SKILL, 'schemas/v1.mjs'));
const { discoverAuditServerPaths } = await import(join(SKILL, 'lib/adapters/internal-audit-session.mjs'));

const readJson = (p) => JSON.parse(readFileSync(join(SKILL, p), 'utf8'));
const prefix = profileId.replace(/_/gu, '-');

console.log(`reading the account record for ${flags.location} ...`);
const location = await readLocation({ worker, token, locationId: flags.location });
const timezone = location.timezone;
const companyId = location.companyId;
const currency = flags.currency ?? 'AUD';
if (!timezone || !companyId) throw new Error('INIT_LOCATION_INCOMPLETE missing timezone or companyId');
console.log(`  name      ${location.name}`);
console.log(`  companyId ${companyId}`);
console.log(`  timezone  ${timezone}   (the ACCOUNT's own, not its city)`);

const cutoff = flags.cutoff ? Number(flags.cutoff) : lastMondayMidnight(timezone);
if (!Number.isSafeInteger(cutoff)) throw new Error('INIT_BAD_CUTOFF');
if (cutoff >= Date.now()) throw new Error('INIT_CUTOFF_NOT_CLOSED a week must close before it can be read');

const policy = loadTrustedPublicReadPolicy();
const projection = readJson(`profiles/${prefix}-projection.v1.json`);
const metricProfile = readJson(`profiles/${prefix}-metrics.v1.json`);
const budgets = loadCollectionBudgets();
// The MERGED profile: this account's own name and caveats are part of what the run is sealed against.
const coverageProfile = loadProfile(profileId, flags.location);

/*
 * EXACTLY the reads the projection declares an `operationIdPattern` for, and no others. An approved
 * but unprojected read is collected, sealed, and then dropped on the floor, and the run measures
 * nothing while reporting success. `operationId` IS the action id, deliberately.
 */
const CAPABILITIES = projection.sources
  .map(({ operationIdPattern }) => ({ operationId: operationIdPattern, actionId: operationIdPattern }))
  .sort((a, b) => (a.operationId < b.operationId ? -1 : 1));

const providerId = `grom-ghl-mcp-${flags.label}`;
const capabilityManifestHash = sha256({
  schemaVersion: '1.0.0',
  providerId,
  expectedLocationId: flags.location,
  publicCatalogSnapshotHash: policy.snapshotHash,
  publicReadAllowlistHash: policy.allowlistHash,
  capabilities: CAPABILITIES.map(({ operationId, actionId }) => ({ actionId, operationId })),
});

const context = {
  schemaVersion: '1.0.0',
  accountLabel: flags.label,
  operatingProfile: profileId,
  targetKind: 'location',
  currency,
  revenueBasis: projection.revenueBasis,
  // `--note` is where the human context goes: the city, whose account it is, anything a reader
  // of a sealed run months later would need. It is part of `contextHash`, so it is sealed too.
  note: flags.note ?? `${location.name}. Read-only weekly commercial diagnostic.`,
};

const config = {
  schemaVersion: '1.0.0',
  adapterKind: 'ghl_public',
  providerId,
  expectedLocationId: flags.location,
  capabilityManifestHash,
  publicCatalogSnapshotHash: policy.snapshotHash,
  publicReadAllowlistHash: policy.allowlistHash,
  credentialRef: { kind: 'environment', name: flags['credential-env'] },
  transport: { kind: 'ghl-native-streamable-http', url: worker, credentialHeaderName: 'X-GHL-Token' },
  capabilities: CAPABILITIES,
  internalAudit: {
    transport: {
      kind: 'ghl-internal-audit-stdio',
      serverPath: discoverAuditServerPaths()[0],
      tokenFilePath: flags['token-file'] ?? null,
    },
    companyId,
    // Empty on a first run: a runtime window is expensive and the busiest sequences are unknown
    // until a roster exists. A workflow without one records RUNTIME_NOT_REQUESTED, which is honest.
    runtimeWorkflowIds: [],
    budgets: { maxDefinitions: 60, maxRuntimeWindows: 3, maxLogPages: 30 },
    emailCopy: true,
    // The other half of the conversation. See `lib/adapters/conversation-transcripts.mjs`.
    conversationTranscripts: true,
  },
  cutoff,
  timezone,
  rawEvidenceRetentionDays: 7,
  frozenInputs: {
    locationId: flags.location,
    target: { targetKind: 'location', operatingProfile: profileId, locationId: flags.location },
    cutoff,
    timezone,
    contextHash: sha256(context),
    coverageProfileHash: sha256(coverageProfile),
    metricProfileHash: sha256(metricProfile),
    rulesetHash: sha256(projection),
    codeHash: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SKILL }).toString().trim(),
    auditProfileHash: sha256({
      profileId: coverageProfile.profileId,
      version: coverageProfile.version,
      targetKind: coverageProfile.targetKind,
    }),
    providerToolProfileHash: sha256({ schemaVersion: '1.0.0', providerId, translatedActionIds: [...translatedActionIds()] }),
    windowDefinitionsHash: sha256({ windowNames: [...WINDOW_NAMES], defaultReportingWindows: [...DEFAULT_REPORTING_WINDOWS] }),
    collectionBudgetHash: sha256(budgets),
    capabilityManifestHashes: [capabilityManifestHash],
    capabilityProofIndexHash: sha256({ schemaVersion: '1.0.0', capabilityManifestHash, receipts: [], attestations: [] }),
    capabilityReceiptHashes: [],
    capabilityAttestationHashes: [],
    capabilityProofExpiries: [],
  },
  context,
  reviews: [],
};

mkdirSync(projectRoot, { recursive: true });
const configPath = join(projectRoot, `provider-${flags.label}.json`);
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

// The vault key. Written ONCE and never regenerated: losing it makes every sealed run unreadable.
const keyDir = join(projectRoot, '.keys');
mkdirSync(keyDir, { recursive: true, mode: 0o700 });
const keyPath = join(keyDir, `${flags.label}.key`);
const keyExisted = existsSync(keyPath);
if (!keyExisted) writeFileSync(keyPath, randomBytes(64), { mode: 0o600 });

/*
 * The account facts STUB. Written only when absent, and deliberately left empty of caveats rather
 * than guessed: a caveat is an instruction about how to read evidence, and an invented one tells an
 * expert to explain away a real defect. It must be filled from the owner BEFORE the first run,
 * because the briefs are sealed and a caveat added afterwards can never reach an expert.
 */
const factsPath = join(SKILL, 'profiles', 'accounts', `${flags.location}.v1.json`);
const factsExisted = existsSync(factsPath);
if (!factsExisted) {
  mkdirSync(dirname(factsPath), { recursive: true });
  writeFileSync(factsPath, `${JSON.stringify({
    profileId,
    situation: { accountName: location.name, knownDataCaveats: [] },
  }, null, 2)}\n`);
}

console.log('');
console.log(`config      ${configPath}`);
console.log(`vault key   ${keyPath}${keyExisted ? '  (already existed, left alone)' : '  (NEW — lose this and the evidence is unreadable)'}`);
console.log(`facts       ${factsPath}${factsExisted ? '  (already existed, left alone)' : '  (STUB — fill knownDataCaveats BEFORE the first run)'}`);
console.log(`cutoff      ${cutoff}  ${new Date(cutoff).toISOString()}  (Monday 00:00 ${timezone})`);
console.log('');
if (!factsExisted) {
  console.log('🔴 ASK THE OWNER FOR THIS ACCOUNT\'S CAVEATS AND WRITE THEM IN NOW.');
  console.log('   Anything that would make a number mean something other than what it looks like:');
  console.log('   who marks outcomes, which calendars are two-phase, what is deliberately switched');
  console.log('   off, whether deposits are taken, where test data lives. A caveat added after the');
  console.log('   run cannot reach a sealed brief, and a missing one becomes a confident wrong finding.');
  console.log('');
}
console.log('then:');
console.log(`  ${flags['credential-env']}=... node cli/audit.mjs run --mode weekly \\`);
console.log(`    --project ${projectRoot} --location ${flags.location} --profile ${profileId} \\`);
console.log(`    --provider-config ${configPath} \\`);
console.log(`    --vault-key-ref protected-file:${keyPath}`);

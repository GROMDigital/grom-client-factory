import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { canonicalJson, sha256 } from './canonical.mjs';
import { prepareAnalysisArtifacts } from './cycle.mjs';
import { createInternalGhlAdapter } from './adapters/internal-ghl.mjs';
import {
  assertTranslatableCapabilities,
  createGhlTranslatingConnect,
} from './adapters/ghl-public-translator.mjs';
import {
  GHL_NATIVE_TRANSPORT_KIND,
  createGhlNativeConnect,
  validateGhlNativeTransport,
} from './adapters/ghl-native-session.mjs';
import {
  DEFAULT_BUDGETS as DEFAULT_INTERNAL_BUDGETS,
  createInternalAuditCollector,
} from './adapters/internal-audit-collector.mjs';
import { createInternalAuditAdapter } from './adapters/internal-audit.mjs';
import {
  createInternalAuditConnect,
  validateInternalAuditTransport,
} from './adapters/internal-audit-session.mjs';
import { connectMcp } from './adapters/mcp-transport.mjs';
import { createPublicGhlAdapter } from './adapters/public-ghl.mjs';
import { loadTrustedPublicReadPolicy } from './adapters/trusted-public-policy.mjs';
import { createAuditKernel, planWeeklyCollection, sealFrozenInputs } from './kernel.mjs';
import { measurePublicEvidence } from './measurement.mjs';
import { auditPaths } from './paths.mjs';
import { openState } from './state.mjs';
import { openVault, resolveVaultKeys } from './vault.mjs';
import { loadPublicReadAllowlist } from '../schemas/v1.mjs';

const LOCAL_SCHEMA = '1.0.0';
const INTERNAL_LIMITATIONS = Object.freeze([
  'INTERNAL_WORKFLOW_DEFINITION_MISSING',
  'INTERNAL_WORKFLOW_RUNTIME_MISSING',
]);

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isWithin(parent, candidate) {
  const fromParent = relative(parent, candidate);
  return fromParent === ''
    || (!isAbsolute(fromParent) && fromParent !== '..' && !fromParent.startsWith(`..${sep}`));
}

/**
 * Finding R3-4. `isWithin` is LEXICAL and `O_NOFOLLOW` guards only the FINAL path component, so
 * a symlinked DIRECTORY anywhere in the middle of the path escaped the project root: the
 * containment check saw `<project>/link/config.json`, the open saw a regular file, and a file
 * outside the project was read and parsed. Both sides are resolved to their real paths first,
 * so containment is decided on what the filesystem will actually open.
 */
function realWithin(parent, candidate, code) {
  let realParent;
  let realCandidate;
  try {
    realParent = realpathSync(parent);
    realCandidate = realpathSync(candidate);
  } catch {
    throw codedError(code);
  }
  if (!isWithin(realParent, realCandidate)) throw codedError(code);
  return realCandidate;
}

function readRegularJson(pathname, code) {
  let descriptor;
  try {
    descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error();
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!isPlainObject(parsed)) throw new Error();
    return parsed;
  } catch {
    throw codedError(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateLocalConfig(config) {
  if (
    !isPlainObject(config)
    || config.schemaVersion !== LOCAL_SCHEMA
    || config.adapterKind !== 'local_fixture'
    || typeof config.providerId !== 'string'
    || config.providerId.length === 0
    || !Number.isSafeInteger(config.cutoff)
    || typeof config.timezone !== 'string'
    || config.timezone.length === 0
    || !isPlainObject(config.frozenInputs)
    || !isPlainObject(config.context)
    || !isPlainObject(config.publicEvidence)
    || !Array.isArray(config.reviews)
  ) throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  // Finding R2-M4: the internal rail is OPTIONAL and OFF unless the configuration declares it.
  // A declaration that is present but malformed fails preflight rather than silently
  // degrading to a public-only run that looks identical to a configured one.
  if (Object.hasOwn(config, 'internalRail') && config.internalRail !== null) {
    validateInternalRailConfig(config.internalRail);
  }
  return config;
}

/**
 * Finding R2-M4 — the composition root.
 *
 * No shipped code constructed `createInternalGhlAdapter`, so the delivered CLI was inert and the
 * doctor's WARN text described behaviour the shipped runtime could not produce. Construction is
 * CONFIGURATION-DRIVEN ONLY: no credential is read, no network transport exists here, and an
 * unconfigured run builds no adapter at all and behaves exactly as before.
 *
 * A host that owns a real authenticated MCP session injects it as `internalClient`; otherwise
 * the only transport this runtime can build is `inline_responses`, an offline replay of bodies
 * recorded in the provider configuration itself.
 */
function validateInternalRailConfig(rail) {
  const transport = rail?.transport;
  if (
    !isPlainObject(rail)
    || rail.adapterKind !== 'internal_ghl'
    || typeof rail.contractVersion !== 'string'
    || rail.contractVersion.length === 0
    || typeof rail.locationId !== 'string'
    || rail.locationId.length === 0
    || typeof rail.toolProfileHash !== 'string'
    || rail.toolProfileHash.length === 0
    || !isPlainObject(rail.capabilityProofIndex)
    || !isPlainObject(transport)
    || !['inline_responses', 'host_injected'].includes(transport.kind)
    || transport.kind === 'inline_responses' && (
      !isPlainObject(transport.responses) || !isPlainObject(transport.toolsList)
    )
  ) throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  // Finding R4-C1, the composition-root half. Declaring these two identities used to be
  // OPTIONAL, and since decision D11 deleted the adapter pin channel there was no longer any
  // cost to leaving them out — so the "every identity this runtime pins must also be sealed"
  // rule below was opt-OUT and a rail that simply omitted both keys skipped it entirely. They
  // are MANDATORY now: a rail that will not state which manifest and which bundle it is
  // running cannot be checked against the run's seal, and an uncheckable rail fails closed.
  for (const key of ['capabilityManifestHash', 'bundleHash']) {
    if (typeof rail[key] !== 'string' || rail[key].length === 0) {
      throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
    }
  }
  return rail;
}

/** An OFFLINE replay client. It reads recorded bodies only; it opens no socket of any kind. */
function inlineResponseClient({ toolsList, responses }) {
  const body = (name) => (
    name === 'tools/list'
      ? { ok: true, data: structuredClone(toolsList) }
      : Object.hasOwn(responses, name)
        ? structuredClone(responses[name])
        : { ok: false, code: 'INTERNAL_AUDIT_RESPONSE_UNAVAILABLE' }
  );
  return {
    async listTools() {
      return structuredClone(toolsList);
    },
    async callTool(request) {
      return {
        content: [{ type: 'text', text: JSON.stringify(body(request?.name)) }],
      };
    },
  };
}

/**
 * Finding R3-C2, the composition-root half. The rail record declared `toolProfileHash`,
 * `capabilityManifestHash` and `bundleHash` as SIBLINGS of the very proof index they were
 * supposed to anchor, so "pinned outside the untrusted proof index" was satisfied by the
 * untrusted record itself. Every identity this runtime pins must now also appear in the run's
 * SEALED frozen inputs (decision D3), and a declared identity the run never sealed fails
 * preflight closed rather than silently anchoring itself.
 */
function sealedDigestSet(frozenInputs, sealedList) {
  return new Set(
    (Array.isArray(frozenInputs?.[sealedList]) ? frozenInputs[sealedList] : [])
      .filter((entry) => typeof entry === 'string' && entry.length > 0),
  );
}

/**
 * Finding R4-C1. Every rail-declared identity must be sealed in the run's frozen inputs, and
 * each must consume a DISTINCT sealed value from the slot that NAMES it. A rail that points
 * its bundle at the manifest digest, at the tool-profile digest, or at a proof-chain digest
 * (an attestation hash, a receipt hash, the proof-index hash) is reusing another identity's
 * seal, which is the whole R4-C1 attack, and it is refused before any evidence call happens.
 */
function assertSealedRailIdentities(rail, frozenInputs) {
  const fail = () => {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  };
  if (!isPlainObject(frozenInputs)) fail();
  const sealedProfile = frozenInputs.providerToolProfileHash;
  if (typeof sealedProfile !== 'string' || sealedProfile.length === 0) fail();
  if (rail.toolProfileHash !== sealedProfile) fail();
  const manifests = sealedDigestSet(frozenInputs, 'capabilityManifestHashes');
  const proofDigests = new Set([
    ...sealedDigestSet(frozenInputs, 'capabilityAttestationHashes'),
    ...sealedDigestSet(frozenInputs, 'capabilityReceiptHashes'),
    ...(typeof frozenInputs.capabilityProofIndexHash === 'string'
      && frozenInputs.capabilityProofIndexHash.length > 0
      ? [frozenInputs.capabilityProofIndexHash]
      : []),
  ]);
  const identities = [
    rail.toolProfileHash,
    rail.capabilityManifestHash,
    rail.bundleHash,
  ];
  if (new Set(identities).size !== identities.length) fail();
  for (const identity of identities) {
    if (proofDigests.has(identity)) fail();
  }
  for (const identity of [rail.capabilityManifestHash, rail.bundleHash]) {
    if (!manifests.has(identity)) fail();
  }
}

/**
 * Finding R4-I2, the composition-root half. `lib/vault.mjs:78` splits ONE key file into
 * `[encryptionKey | pseudonymKey]`, 32 bytes each, and the second half is the pseudonym key.
 * This runtime minted exactly such a pair in its `keyResolver` and then threw the pseudonym key
 * away, so the adapter fell back to `randomBytes(32)` per instance: two collections over
 * byte-identical fixtures produced different pseudonyms, `sha256(internalEvidence)` — which
 * `lib/kernel.mjs` bakes into the `normalizing` checkpoint input — was not reproducible, and no
 * cross-run join was possible on either pseudonymised ledger.
 *
 * The material is DERIVED here the way the vault derives it, and it is a function of the vault
 * key reference alone, so it is identical on every run of the same location and is never a
 * per-process value. The key itself never leaves the adapter and is never published.
 */
const LOCAL_KEY_REFERENCE = 'test-only:key';
const LOCAL_KEY_BYTES = 32;

function localKeyMaterial(keyReference) {
  if (keyReference !== LOCAL_KEY_REFERENCE) {
    throw codedError('AUDIT_PREFLIGHT_FAILED_VAULT_REFERENCE');
  }
  // The same 64-byte layout `lib/vault.mjs` reads from a key file, split the same way.
  const material = Buffer.concat([
    Buffer.alloc(LOCAL_KEY_BYTES, 0x31),
    Buffer.alloc(LOCAL_KEY_BYTES, 0x32),
  ]);
  return {
    encryptionKey: Buffer.from(material.subarray(0, LOCAL_KEY_BYTES)),
    pseudonymKey: Buffer.from(material.subarray(LOCAL_KEY_BYTES)),
  };
}

// ---------------------------------------------------------------------------
// Finding R6-C3 — the trust root was CO-LOCATED with the thing it anchors
// ---------------------------------------------------------------------------

/**
 * Round 5's cryptographic anchoring defeats every forgery from OUTSIDE the configuration, which
 * is real. It does not defeat the configuration ITSELF: `frozenInputs` and
 * `internalRail.capabilityProofIndex` were siblings of ONE `loadProjectConfig` record, so a
 * single actor wrote both halves, sealed the hash of the attestation it had just minted, and
 * `assertSealedRailIdentities` agreed with it because it only ever checked the two halves of the
 * same file against each other. `complete_full`, publisher called, `approver: "nobody"`.
 *
 * A seal is only a seal if the sealed party cannot mint it. The anchoring half of the frozen
 * inputs is therefore no longer taken from the record that carries the proof chain. It comes
 * from a SEPARATE, AUTHENTICATED document:
 *
 *  1. a different file — not the provider config, resolved through `realpathSync` so a symlink
 *     cannot make the two the same file;
 *  2. carrying anchors ONLY — the document is exact-field validated, so it can hold no rail,
 *     no transport, no proof index and no receipts. There is nothing in it to forge WITH;
 *  3. authenticated with a MAC keyed by the run's VAULT key material, which the provider
 *     configuration does not contain and its author cannot read. This is the part that actually
 *     decides: an actor who can write both files still cannot produce the MAC.
 *
 * FAIL CLOSED, in both directions:
 *  - a rail configured with NO seal keeps running, but its frozen inputs carry NO anchors, so
 *    `sealedIdentityAnchors` is not `ready`, gate 2 fails, and the run can only ever be
 *    `complete_partial`. Absent authentication is missing evidence, not an integrity failure.
 *  - a seal that is DECLARED and does not verify fails PREFLIGHT, matching the R2-M4 precedent
 *    that a malformed declaration is refused rather than silently degraded.
 */
const SEAL_DOMAIN = 'grom.audit.frozen-input-seal.v1';
const SEAL_KIND = 'frozen_input_seal';

/** The exact frozen-input fields that ANCHOR an identity. Nothing else is taken from the seal. */
const SEALED_ANCHOR_FIELDS = Object.freeze([
  'providerToolProfileHash',
  'capabilityManifestHashes',
  'capabilityProofIndexHash',
  'capabilityReceiptHashes',
  'capabilityAttestationHashes',
  'capabilityProofExpiries',
]);

/**
 * The anchor values of a run that authenticated nothing. Both strings stay non-empty because
 * `lib/state.mjs` requires it, and both are deliberately NOT digest-shaped, so neither can
 * collide with a real tool-profile or proof-index digest. Every SET is empty, which is what
 * `sealedIdentityAnchors` reads: no sealed manifest and no sealed attestation means not `ready`.
 */
const UNSEALED_ANCHOR = Object.freeze({
  providerToolProfileHash: 'unsealed:no-independent-frozen-input-seal',
  capabilityManifestHashes: Object.freeze([]),
  capabilityProofIndexHash: 'unsealed:no-independent-frozen-input-seal',
  capabilityReceiptHashes: Object.freeze([]),
  capabilityAttestationHashes: Object.freeze([]),
  capabilityProofExpiries: Object.freeze([]),
});

function sealAuthenticationKey(vaultKeyReference) {
  const { encryptionKey, pseudonymKey } = localKeyMaterial(vaultKeyReference);
  // Domain-separated from every other use of the same key material, so a value produced for one
  // purpose can never be replayed as a seal.
  return createHmac('sha256', Buffer.concat([encryptionKey, pseudonymKey]))
    .update(SEAL_DOMAIN)
    .digest();
}

function sealMacFor({ locationId, anchors, canaryTargetHashes }, vaultKeyReference) {
  return createHmac('sha256', sealAuthenticationKey(vaultKeyReference))
    .update(canonicalJson({
      anchors,
      canaryTargetHashes,
      domain: SEAL_DOMAIN,
      kind: SEAL_KIND,
      locationId,
      schemaVersion: LOCAL_SCHEMA,
    }))
    .digest('hex');
}

/**
 * Mints a seal document. A real host does this from its own vault, on a machine the provider
 * configuration's author does not control; this runtime exposes it so an operator (and the test
 * suite) can produce one without reimplementing the MAC.
 */
export function mintFrozenInputSeal({
  locationId,
  anchors,
  canaryTargetHashes,
  vaultKeyReference,
} = {}) {
  const document = {
    schemaVersion: LOCAL_SCHEMA,
    kind: SEAL_KIND,
    locationId,
    anchors: Object.fromEntries(SEALED_ANCHOR_FIELDS.map((field) => [field, anchors?.[field]])),
    canaryTargetHashes: Array.isArray(canaryTargetHashes) ? [...canaryTargetHashes] : [],
  };
  assertSealDocumentShape(document);
  return { ...document, mac: sealMacFor(document, vaultKeyReference) };
}

function assertSealDocumentShape(document) {
  const fail = () => {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  };
  if (
    !isPlainObject(document)
    || document.schemaVersion !== LOCAL_SCHEMA
    || document.kind !== SEAL_KIND
    || typeof document.locationId !== 'string'
    || document.locationId.length === 0
    || !isPlainObject(document.anchors)
    || !Array.isArray(document.canaryTargetHashes)
  ) fail();
  // Exact-field at the TOP level too. The MAC covers only the fields it names, so an unnamed
  // key would ride along unauthenticated — and a document that may carry arbitrary keys is a
  // document that can carry a proof chain, which is precisely what it must not be able to do.
  const documentKeys = Object.keys(document).sort();
  const documentExpected = ['anchors', 'canaryTargetHashes', 'kind', 'locationId', 'schemaVersion'];
  if (documentKeys.length !== documentExpected.length) fail();
  if (documentKeys.some((key, index) => key !== documentExpected[index])) fail();
  // Exact-field on the anchors: the seal document may carry NOTHING but anchors, so there is no
  // rail, transport, proof index, receipt or attestation material inside it to seal itself with.
  const anchorKeys = Object.keys(document.anchors).sort();
  const expected = [...SEALED_ANCHOR_FIELDS].sort();
  if (anchorKeys.length !== expected.length) fail();
  if (anchorKeys.some((key, index) => key !== expected[index])) fail();
  for (const field of ['providerToolProfileHash', 'capabilityProofIndexHash']) {
    if (typeof document.anchors[field] !== 'string' || document.anchors[field].length === 0) {
      fail();
    }
  }
  for (const field of [
    'capabilityManifestHashes',
    'capabilityReceiptHashes',
    'capabilityAttestationHashes',
  ]) {
    const value = document.anchors[field];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      fail();
    }
  }
  if (
    !Array.isArray(document.anchors.capabilityProofExpiries)
    || document.anchors.capabilityProofExpiries.some(
      (entry) => !Number.isSafeInteger(entry) || entry < 0,
    )
  ) fail();
  // R6-I2 — a canary is scoped to the accounts it may support, and the scope is stated HERE,
  // inside the authenticated document, because it is exactly the kind of decision the proof
  // chain must not be able to write for itself.
  if (document.canaryTargetHashes.some(
    (entry) => typeof entry !== 'string' || entry.length === 0,
  )) fail();
  return document;
}

function macMatches(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Loads and authenticates the independent seal, or returns `null` when the configuration
 * declares none. A DECLARED seal that does not verify throws.
 */
function loadFrozenInputSeal(config, { projectRoot, vaultKeyReference, providerDescriptor }) {
  const fail = () => {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  };
  const declaration = config.frozenInputSeal;
  if (declaration === undefined || declaration === null) return null;
  if (
    !isPlainObject(declaration)
    || declaration.kind !== 'project_file'
    || typeof declaration.relativePath !== 'string'
    || declaration.relativePath.length === 0
    || typeof projectRoot !== 'string'
    || projectRoot.length === 0
    || typeof vaultKeyReference !== 'string'
    || vaultKeyReference.length === 0
  ) fail();
  const project = resolve(projectRoot);
  const pathname = resolve(project, declaration.relativePath);
  if (!isWithin(project, pathname)) fail();
  const realPathname = realWithin(project, pathname, 'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  // A seal that is the provider configuration is not an independent source, however it is
  // spelled. Compared on the REAL path so a symlink cannot make one file look like two.
  const declaredConfigPath = typeof providerDescriptor?.relativePath === 'string'
    ? providerDescriptor.relativePath
    : null;
  if (declaredConfigPath !== null) {
    let realConfigPath;
    try {
      realConfigPath = realpathSync(resolve(project, declaredConfigPath));
    } catch {
      realConfigPath = null;
    }
    if (realConfigPath !== null && realConfigPath === realPathname) fail();
  }
  const document = readRegularJson(realPathname, 'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  const { mac, ...body } = document;
  assertSealDocumentShape(body);
  if (!macMatches(sealMacFor(body, vaultKeyReference), mac)) fail();
  // The seal states which ACCOUNT it authorizes. A seal minted for another location anchors
  // nothing here, and says so rather than being quietly ignored.
  if (body.locationId !== config.internalRail?.locationId) fail();
  return Object.freeze({
    anchors: Object.freeze({ ...body.anchors }),
    canaryTargetHashes: Object.freeze([...body.canaryTargetHashes]),
    locationId: body.locationId,
  });
}

/**
 * The frozen inputs this run is actually sealed with.
 *
 * A public-only run is byte-identical to before: no rail means no anchoring question. A run WITH
 * a rail gets its anchor fields from the independent seal, or gets the unsealed anchor and can
 * never lift the `complete_partial` clamp.
 *
 * Finding R7-C1 — and the anchors leave this host WITH THEIR PROVENANCE. The kernel accepts any
 * `freezeInputs` return, so a claim that is merely PRESENT proves nothing about who made it;
 * `sealFrozenInputs` MACs the anchor digest with the vault key material this runtime just
 * derived, which is the same material that authenticated the independent seal document and is
 * exactly what the provider configuration's author cannot read. A run with no independent seal
 * returns its unsealed anchors PLAIN — unprovenanced, so still Partial-only, and byte-identical
 * to what it returned before.
 */
function effectiveFrozenInputs(config, context) {
  const declared = structuredClone(config.frozenInputs);
  if (config.internalRail === undefined || config.internalRail === null) return declared;
  const seal = loadFrozenInputSeal(config, context);
  if (seal === null) return { ...declared, ...structuredClone(UNSEALED_ANCHOR) };
  return sealFrozenInputs({
    frozenInputs: { ...declared, ...structuredClone(seal.anchors) },
    keys: localKeyMaterial(context.vaultKeyReference),
  });
}

function buildInternalAdapter(
  rail,
  internalClient,
  frozenInputs = null,
  pseudonymKey = null,
  seal = null,
) {
  if (rail === undefined || rail === null) return null;
  validateInternalRailConfig(rail);
  // With an independent seal the rail is checked against THAT, so an identity the config author
  // sealed for itself no longer counts. Without one, the pre-existing same-record shape check
  // still runs — it is not a trust root and never was, but it still refuses a rail that will not
  // state its identities, and a run in that state cannot reach `complete_full` anyway.
  assertSealedRailIdentities(rail, seal === null ? frozenInputs : { ...frozenInputs, ...seal.anchors });
  const client = rail.transport.kind === 'host_injected'
    ? internalClient
    : inlineResponseClient(rail.transport);
  if (!client || typeof client.callTool !== 'function') {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  }
  const options = {
    client,
    expectedContractVersion: rail.contractVersion,
    expectedLocationId: rail.locationId,
    expectedToolProfileHash: rail.toolProfileHash,
    capabilityProofIndex: structuredClone(rail.capabilityProofIndex),
  };
  // R4-I2: forwarded, so `pseudonymBinding.keySource` is `injected` and the artefact is
  // reproducible. A key that is present but unusable is a caller error and throws in the
  // adapter rather than silently degrading to the ephemeral path.
  if (pseudonymKey !== null) options.pseudonymKey = pseudonymKey;
  // Both identities are MANDATORY now (finding R4-C1), and both have been checked against the
  // run's seal above, so both are always handed to the adapter.
  options.expectedCapabilityManifestHash = rail.capabilityManifestHash;
  options.expectedBundleHash = rail.bundleHash;
  // R6-I2 — the canary scope, and ONLY from the authenticated seal. The rail record cannot
  // widen its own scope: a run with no independent seal declares no scope, and a run with one
  // is held to exactly the accounts that seal names.
  if (seal !== null) options.authorizedCanaryTargetHashes = [...seal.canaryTargetHashes];
  return createInternalGhlAdapter(options);
}

function loadProjectConfig({ descriptor, projectRoot }) {
  if (
    !isPlainObject(descriptor)
    || descriptor.kind !== 'project_file'
    || typeof descriptor.relativePath !== 'string'
    || descriptor.relativePath.length === 0
    || typeof descriptor.configHash !== 'string'
  ) throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  const project = resolve(projectRoot);
  const pathname = resolve(project, descriptor.relativePath);
  if (!isWithin(project, pathname)) {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  }
  // Finding R3-4: the lexical check above is necessary but NOT sufficient. The real path is what
  // gets opened, so the real path is what must be inside the project root.
  const realPathname = realWithin(project, pathname, 'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  const config = validateLocalConfig(readRegularJson(
    realPathname,
    'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG',
  ));
  return config;
}

function writeImmutable(pathname, value) {
  const bytes = Buffer.from(
    typeof value === 'string' ? value : `${canonicalJson(value)}\n`,
    'utf8',
  );
  if (existsSync(pathname)) {
    const metadata = lstatSync(pathname);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLICATION_CONFLICT');
    }
    if (!readFileSync(pathname).equals(bytes)) {
      throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLICATION_CONFLICT');
    }
    return;
  }
  mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 });
  const temporary = `${pathname}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const metadata = existsSync(temporary) ? lstatSync(temporary) : undefined;
    if (
      !metadata
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || !readFileSync(temporary).equals(bytes)
    ) throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLICATION_CONFLICT');
  }
  renameSync(temporary, pathname);
  chmodSync(pathname, 0o400);
}

/**
 * The publication writer, parameterised ONLY by its one-line scope statement. `localPublisher`
 * below passes the exact string it always passed, so an offline fixture publication is still
 * byte-for-byte what it was; the public rail passes a statement that is true of a live run.
 */
function publicationPublisher(scopeStatement) {
  return function publish({
    paths,
    runId,
    publicationId,
    compiled,
    verification,
    frozenInputs,
  }) {
    const publicationRoot = join(paths.weekly, publicationId);
    if (existsSync(publicationRoot)) {
      const metadata = lstatSync(publicationRoot);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw codedError('AUDIT_INTEGRITY_FAILURE_PUBLICATION_CONFLICT');
      }
    } else {
      mkdirSync(publicationRoot, { mode: 0o700 });
    }
    const report = [
      '# Weekly GHL audit',
      '',
      'Status: complete_partial',
      '',
      scopeStatement,
      '',
    ].join('\n');
    const manifest = {
      schemaVersion: LOCAL_SCHEMA,
      runId,
      publicationId,
      status: 'complete_partial',
      frozenInputsHash: sha256(frozenInputs),
      compiledHash: sha256(compiled),
      verificationHash: sha256(verification),
    };
    writeImmutable(join(publicationRoot, 'REPORT.md'), report);
    writeImmutable(join(publicationRoot, 'coverage.json'), compiled.coverage);
    writeImmutable(join(publicationRoot, 'result.json'), compiled);
    writeImmutable(join(publicationRoot, 'manifest.json'), manifest);
    return {
      publicationId,
      manifestHash: sha256(manifest),
      publicationRoot: sha256({
        report: sha256(report),
        coverage: sha256(compiled.coverage),
        result: sha256(compiled),
        manifest: sha256(manifest),
      }),
    };
  };
}

const localPublisher = publicationPublisher(
  'This offline fixture publication covers the public comparable subset only.',
);

export function localProviderDescriptor({ projectRoot, providerConfigPath, config }) {
  const project = resolve(projectRoot);
  const pathname = resolve(providerConfigPath);
  if (!isWithin(project, pathname)) {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  }
  // Finding R3-4, the minting side: a descriptor is never issued for a path whose REAL location
  // is outside the project, so the escape cannot be created here either. The relative path below
  // stays lexical, so the descriptor bytes are unchanged for every legitimate configuration.
  realWithin(project, pathname, 'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  validateLocalConfig(config);
  return Object.freeze({
    kind: 'project_file',
    configHash: sha256(config),
    relativePath: relative(project, pathname).split(sep).join('/'),
  });
}

export function createLocalAuditKernel({ initialRunId, internalClient = null } = {}) {
  let nextRunId = initialRunId;
  return createAuditKernel({
    clock: () => Date.now(),
    idFactory: () => {
      const selected = nextRunId ?? `run_${randomUUID()}`;
      nextRunId = undefined;
      return selected;
    },
    keyResolver: (reference) => localKeyMaterial(reference),
    stateStore: { open: openState },
    providerConfigLoader: loadProjectConfig,
    adapters: {
      collectContext: async ({ providerConfig }) => {
        validateLocalConfig(providerConfig);
        return structuredClone(providerConfig.context);
      },
      collectPublic: async ({ providerConfig }) => {
        validateLocalConfig(providerConfig);
        return structuredClone(providerConfig.publicEvidence);
      },
      // Finding R2-M4. Returns `null` — the byte-identical public-only path — unless the
      // configuration declares an internal rail. No live call, credential read, network access
      // or scheduler is introduced by this wiring.
      collectInternal: async ({
        providerConfig,
        vaultKeyReference,
        projectRoot,
        providerDescriptor,
      }) => {
        const config = validateLocalConfig(providerConfig);
        // R6-C3 — re-authenticated here rather than carried from `freezeInputs`, so the adapter
        // is built from the seal the filesystem actually holds at collection time.
        const seal = config.internalRail
          ? loadFrozenInputSeal(config, { projectRoot, vaultKeyReference, providerDescriptor })
          : null;
        return buildInternalAdapter(
          config.internalRail,
          internalClient,
          config.frozenInputs,
          // R4-I2 — the vault's own pseudonym key, derived exactly as `lib/vault.mjs:78`
          // derives it and stable across every run of this location. The kernel does not hand
          // the resolved keys to `collectInternal`, so it is re-derived from the same
          // reference rather than being carried in the phase arguments.
          config.internalRail ? localKeyMaterial(vaultKeyReference).pseudonymKey : null,
          seal,
        );
      },
    },
    analyzer: {
      // R6-C3 — the run is sealed with the INDEPENDENT anchors, or with none at all. This is
      // the value the kernel hashes into `frozenInputsHash`, checkpoints, resume-checks and
      // hands to `evaluateFullEligibility` as the anchor, so it is the one that decides.
      freezeInputs: ({
        providerConfig,
        projectRoot,
        vaultKeyReference,
        providerDescriptor,
      }) => effectiveFrozenInputs(
        validateLocalConfig(providerConfig),
        { projectRoot, vaultKeyReference, providerDescriptor },
      ),
      normalize: async ({ context, publicEvidence }) => ({
        contextHash: sha256(context),
        publicEvidenceHash: sha256(publicEvidence),
      }),
      discover: async () => ({ findings: [] }),
      falsify: async () => ({ packets: [] }),
      loadMemory: async () => ({ events: [] }),
      createReviewRequests: async ({ providerConfig }) => (
        structuredClone(validateLocalConfig(providerConfig).reviews)
      ),
      prioritize: async ({ discovery, falsification, reviews }) => ({
        discovery,
        falsification,
        reviewHashes: reviews.map((review) => sha256(review)).sort(),
      }),
      compile: async () => ({
        status: 'complete_partial',
        coverage: {
          state: 'complete_partial',
          scope: 'public_comparable_subset',
          limitations: [...INTERNAL_LIMITATIONS],
        },
        diff: { state: 'FIRST_BASELINE', transitions: [] },
        findings: [],
      }),
    },
    verifier: async ({ compiled }) => {
      const limitations = new Set(compiled?.coverage?.limitations ?? []);
      return {
        result: compiled?.status === 'complete_partial'
          && limitations.has(INTERNAL_LIMITATIONS[0])
          && limitations.has(INTERNAL_LIMITATIONS[1])
          ? 'pass'
          : 'fail',
      };
    },
    publisher: localPublisher,
  });
}

// ---------------------------------------------------------------------------
// The PUBLIC composition root — `adapterKind: 'ghl_public'`
// ---------------------------------------------------------------------------

/**
 * `createPublicGhlAdapter` and `connectMcp` shipped fully built and fully tested in Task 4 and
 * were then referenced by NOTHING outside their own tests: `cli/audit.mjs` only ever built a
 * kernel for `adapterKind: 'local_fixture'`, whose `collectPublic` returns a JSON blob copied out
 * of the provider configuration. The delivered CLI could therefore replay a fixture and could not
 * audit an account. This is the missing half — the same wiring style as the INTERNAL rail above:
 * CONFIGURATION-DRIVEN construction, credential REFERENCES only, and a transport that is either
 * host-injected or the SDK's own.
 *
 * The `local_fixture` path above is untouched: a public run is a DIFFERENT `adapterKind`, a
 * different validator, a different descriptor minter and a different kernel factory.
 */
const PUBLIC_ADAPTER_KIND = 'ghl_public';
const PUBLIC_SOURCE = 'public_ghl';
const PUBLIC_HEX64 = /^[a-f0-9]{64}$/u;
const PUBLIC_LOCATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const PUBLIC_OPERATION_ID = /^[a-z0-9][a-z0-9_.:-]{0,63}$/u;
const PUBLIC_KEY_REFERENCE = /^(protected-file|os-keychain):(.+)$/su;
const PUBLIC_REQUIRED_KEYS = Object.freeze([
  'adapterKind',
  'capabilities',
  'capabilityManifestHash',
  'context',
  'credentialRef',
  'cutoff',
  'expectedLocationId',
  'frozenInputs',
  'providerId',
  'publicCatalogSnapshotHash',
  'publicReadAllowlistHash',
  'reviews',
  'schemaVersion',
  'timezone',
  'transport',
]);
const PUBLIC_OPTIONAL_KEYS = Object.freeze([
  // The internal (builder API) rail. OPTIONAL, and its absence is the byte-identical public-only
  // path that every existing configuration already takes. A run only reads workflows if its
  // configuration asks to.
  'internalAudit',
  'lateArrivalHours',
  'providerAvailableFrom',
  'rawEvidenceRetentionDays',
  'runId',
  'salesCycleDays',
]);
const PUBLIC_INTERNAL_AUDIT_KEYS = Object.freeze([
  'budgets',
  'companyId',
  'runtimeWorkflowIds',
  'transport',
]);
/**
 * These two fields are DERIVED, never declared. `lib/state.mjs:109-136` seals them into the run,
 * and Task 4's contract says they must be built from the envelopes the collection actually
 * produced — so a configuration that states its own inventory is stating what it collected before
 * it collected anything. A declared inventory fails preflight rather than being overwritten.
 */
const PUBLIC_DERIVED_FROZEN_FIELDS = Object.freeze([
  'privateSourceInventory',
  'privateSourceInventoryHash',
]);
const PUBLIC_DEFAULT_RETENTION_DAYS = 7;
const PUBLIC_MAXIMUM_RETENTION_DAYS = 30;
const PUBLIC_DAY_MS = 86_400_000;

function publicConfigError() {
  throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
}

function validatePublicTransport(transport) {
  if (
    !isPlainObject(transport)
    // A JSON document cannot carry a function, so a `connect`/`fetch` KEY in the configuration is
    // never the injected seam — it is a value `validateTransport` would silently discard. Refused
    // so a configuration can never look like it is choosing its own transport implementation.
    || Object.hasOwn(transport, 'connect')
    || Object.hasOwn(transport, 'fetch')
  ) publicConfigError();
  if (transport.kind === 'streamable-http') {
    if (
      Object.keys(transport).sort().join(',') !== 'kind,url'
      || typeof transport.url !== 'string'
      || transport.url.length === 0
    ) publicConfigError();
    return;
  }
  if (transport.kind === 'stdio') {
    if (
      Object.keys(transport).sort().join(',') !== 'args,command,kind'
      || typeof transport.command !== 'string'
      || transport.command.length === 0
      || !Array.isArray(transport.args)
      || transport.args.some((argument) => typeof argument !== 'string')
    ) publicConfigError();
    return;
  }
  /**
   * The GHL-NATIVE kind. A configuration that declares it is saying "the server at this URL is a
   * raw GoHighLevel MCP server, authenticated by a bespoke header, and the sub-account is chosen
   * by the token value" — which is what every Grom sub-account is actually reachable through.
   * Declaring it is what makes `lib/adapters/ghl-native-session.mjs` the DEFAULT `ghlNativeConnect`
   * in `collectPublicEvidence`; a host that injects its own seam still wins.
   */
  if (transport.kind === GHL_NATIVE_TRANSPORT_KIND) {
    try {
      validateGhlNativeTransport(transport);
    } catch {
      publicConfigError();
    }
    return;
  }
  publicConfigError();
}

/**
 * The optional internal-rail block.
 *
 * `transport` is validated by `validateInternalAuditTransport`, which accepts three keys, none of
 * which can be a secret or an argv, and which refuses to name anything but the plugin's read-only
 * audit-server bundle inside the plugin cache.
 *
 * `runtimeWorkflowIds` is CONFIGURATION and not a default, because which workflows carry the
 * revenue path is an account fact. A runtime window is expensive enough that guessing wrong costs
 * the run, so nothing in this repository guesses.
 */
function validatePublicInternalAudit(value) {
  if (!isPlainObject(value)) publicConfigError();
  if (Object.keys(value).some((key) => !PUBLIC_INTERNAL_AUDIT_KEYS.includes(key))) {
    publicConfigError();
  }
  if (!Object.hasOwn(value, 'transport')) publicConfigError();
  try {
    validateInternalAuditTransport(value.transport);
  } catch {
    publicConfigError();
  }
  if (Object.hasOwn(value, 'companyId')) {
    if (typeof value.companyId !== 'string' || !PUBLIC_LOCATION_ID.test(value.companyId)) {
      publicConfigError();
    }
  }
  if (Object.hasOwn(value, 'runtimeWorkflowIds')) {
    if (
      !Array.isArray(value.runtimeWorkflowIds)
      || value.runtimeWorkflowIds.some((id) => typeof id !== 'string' || id.length === 0)
    ) publicConfigError();
  }
  if (Object.hasOwn(value, 'budgets')) {
    if (!isPlainObject(value.budgets)) publicConfigError();
    for (const [key, limit] of Object.entries(value.budgets)) {
      if (!Object.hasOwn(DEFAULT_INTERNAL_BUDGETS, key)) publicConfigError();
      if (!Number.isSafeInteger(limit) || limit < 1) publicConfigError();
    }
  }
}

export function validatePublicConfig(config) {
  if (!isPlainObject(config)) publicConfigError();
  const keys = Object.keys(config);
  if (
    keys.some((key) => (
      !PUBLIC_REQUIRED_KEYS.includes(key) && !PUBLIC_OPTIONAL_KEYS.includes(key)
    ))
    || PUBLIC_REQUIRED_KEYS.some((key) => !Object.hasOwn(config, key))
    || config.schemaVersion !== LOCAL_SCHEMA
    || config.adapterKind !== PUBLIC_ADAPTER_KIND
    || typeof config.providerId !== 'string'
    || config.providerId.length === 0
    || typeof config.expectedLocationId !== 'string'
    || !PUBLIC_LOCATION_ID.test(config.expectedLocationId)
    || typeof config.capabilityManifestHash !== 'string'
    || !PUBLIC_HEX64.test(config.capabilityManifestHash)
    || typeof config.publicCatalogSnapshotHash !== 'string'
    || !PUBLIC_HEX64.test(config.publicCatalogSnapshotHash)
    || typeof config.publicReadAllowlistHash !== 'string'
    || !PUBLIC_HEX64.test(config.publicReadAllowlistHash)
    || !(config.credentialRef === null || isPlainObject(config.credentialRef))
    || !Number.isSafeInteger(config.cutoff)
    || typeof config.timezone !== 'string'
    || config.timezone.length === 0
    || !isPlainObject(config.frozenInputs)
    || !isPlainObject(config.context)
    || !Array.isArray(config.reviews)
    || !Array.isArray(config.capabilities)
    || config.capabilities.length === 0
  ) publicConfigError();
  validatePublicTransport(config.transport);
  if (Object.hasOwn(config, 'internalAudit')) validatePublicInternalAudit(config.internalAudit);
  // A GHL MCP worker binds the session to a sub-account ENTIRELY through the token value, so a
  // native transport with no credential reference is a run bound to no account at all. Refused
  // here, at preflight, rather than at connect where it would surface as an opaque
  // MCP_CONNECTION_FAILED with nothing to act on.
  if (config.transport.kind === GHL_NATIVE_TRANSPORT_KIND && config.credentialRef === null) {
    publicConfigError();
  }
  const operationIds = new Set();
  for (const capability of config.capabilities) {
    if (
      !isPlainObject(capability)
      || Object.keys(capability).sort().join(',') !== 'actionId,operationId'
      || typeof capability.actionId !== 'string'
      || capability.actionId.length === 0
      || typeof capability.operationId !== 'string'
      || !PUBLIC_OPERATION_ID.test(capability.operationId)
      || operationIds.has(capability.operationId)
    ) publicConfigError();
    operationIds.add(capability.operationId);
  }
  for (const field of PUBLIC_DERIVED_FROZEN_FIELDS) {
    if (Object.hasOwn(config.frozenInputs, field)) publicConfigError();
  }
  // Cheap, early and free: the account this run is BOUND to must be one account, stated once.
  // Checked here so a cross-account configuration never reaches a transport connect.
  if (
    config.frozenInputs.locationId !== config.expectedLocationId
    || config.frozenInputs.target?.locationId !== config.expectedLocationId
    || !Number.isSafeInteger(config.frozenInputs.cutoff)
    || typeof config.frozenInputs.timezone !== 'string'
    || config.frozenInputs.timezone.length === 0
    // The cutoff and timezone are stated twice — once for the invocation, once inside the SEALED
    // frozen inputs — and the sealed pair is the one that plans the window. Two different answers
    // would mean the run reports one period and collects another.
    || config.cutoff !== config.frozenInputs.cutoff
    || config.timezone !== config.frozenInputs.timezone
  ) publicConfigError();
  for (const [field, limit] of [
    ['salesCycleDays', 3_650],
    ['lateArrivalHours', 8_760],
  ]) {
    if (Object.hasOwn(config, field)) {
      const value = config[field];
      if (!Number.isSafeInteger(value) || value <= 0 || value > limit) publicConfigError();
    }
  }
  if (Object.hasOwn(config, 'providerAvailableFrom')) {
    const value = config.providerAvailableFrom;
    if (
      typeof value !== 'string'
      || !Number.isFinite(Date.parse(value))
      || new Date(Date.parse(value)).toISOString() !== value
    ) publicConfigError();
  }
  if (Object.hasOwn(config, 'rawEvidenceRetentionDays')) {
    const value = config.rawEvidenceRetentionDays;
    if (
      !Number.isSafeInteger(value)
      || value < 1
      || value > PUBLIC_MAXIMUM_RETENTION_DAYS
    ) publicConfigError();
  }
  if (Object.hasOwn(config, 'runId') && (
    typeof config.runId !== 'string' || config.runId.length === 0
  )) publicConfigError();
  return config;
}

function loadPublicProjectConfig({ descriptor, projectRoot }) {
  if (
    !isPlainObject(descriptor)
    || descriptor.kind !== 'project_file'
    || typeof descriptor.relativePath !== 'string'
    || descriptor.relativePath.length === 0
    || typeof descriptor.configHash !== 'string'
  ) throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  const project = resolve(projectRoot);
  const pathname = resolve(project, descriptor.relativePath);
  if (!isWithin(project, pathname)) {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  }
  const realPathname = realWithin(project, pathname, 'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  return validatePublicConfig(readRegularJson(
    realPathname,
    'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG',
  ));
}

export function publicProviderDescriptor({ projectRoot, providerConfigPath, config }) {
  const project = resolve(projectRoot);
  const pathname = resolve(providerConfigPath);
  if (!isWithin(project, pathname)) {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  }
  realWithin(project, pathname, 'AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  validatePublicConfig(config);
  // `project_file`, ALWAYS. `lib/state.mjs` `assertSafeInvocationValue` refuses any invocation
  // value under a key matching /credential/, so an `inline_safe` descriptor carrying this
  // configuration (the kernel's fallback when no descriptor is supplied) would be rejected at
  // run creation because the configuration names a `credentialRef`. The reference itself is never
  // copied into run state; only this path and hash are.
  return Object.freeze({
    kind: 'project_file',
    configHash: sha256(config),
    relativePath: relative(project, pathname).split(sep).join('/'),
  });
}

/**
 * Vault key material for a REAL run. `localKeyMaterial` above is the hermetic constant the
 * fixture rail uses and it stays exactly that; a public run resolves the same 64-byte layout
 * through `lib/vault.mjs` `resolveVaultKeys`, from a reference of the form
 * `protected-file:/absolute/path` or `os-keychain:<name>`. The reference is a REFERENCE: no key
 * value is ever read from the provider configuration, the CLI, or the environment, and nothing
 * here logs, returns or serialises the material.
 */
function publicKeyMaterial(reference, { keyProvider = null } = {}) {
  if (reference === LOCAL_KEY_REFERENCE) return localKeyMaterial(reference);
  const match = typeof reference === 'string' ? PUBLIC_KEY_REFERENCE.exec(reference) : null;
  if (!match) throw codedError('AUDIT_PREFLIGHT_FAILED_VAULT_REFERENCE');
  const [, kind, value] = match;
  try {
    return resolveVaultKeys({
      keyReference: kind === 'protected-file'
        ? { type: 'protected-file', path: value }
        : { type: 'os-keychain', name: value },
      keyProvider,
    });
  } catch {
    // Deliberately opaque, and deliberately the SAME code for every failure mode: a key
    // resolution failure must not describe the key, its location, its permissions or its
    // contents. `VAULT_KEY_FILE_PERMISSIONS` vs `VAULT_KEYS_UNAVAILABLE` is an oracle.
    throw codedError('AUDIT_PREFLIGHT_FAILED_VAULT_REFERENCE');
  }
}

/**
 * The raw page sink, backed by the vault that already exists. `vault.sealRaw` encrypts with
 * AES-256-GCM under the run's key material, mints the `raw_<32 hex>` opaque reference the public
 * adapter validates, and returns `rawHash` = sha256 of the sealed bytes — which, because the
 * bytes ARE the canonical JSON of the page, is byte-identical to the adapter's `sha256(response)`
 * payload hash. No parallel store is introduced; page bodies live where every other private
 * artefact lives, under `private/raw/` at 0600, carrying an expiry the vault's purge honours.
 */
function vaultRawPageSink(vault, expiresAt) {
  return Object.freeze({
    async sealPage({ payload, payloadHash }) {
      const bytes = Buffer.from(canonicalJson(payload), 'utf8');
      let sealed;
      try {
        sealed = vault.sealRaw({ source: PUBLIC_SOURCE, bytes, expiresAt });
      } finally {
        bytes.fill(0);
      }
      if (sealed.rawHash !== payloadHash) throw codedError('RAW_PAGE_SEAL_FAILED');
      return { opaqueRef: sealed.opaqueRef, payloadHash: sealed.rawHash };
    },
    // NO `restorePage`. `lib/vault.mjs` seals and purges; it exposes no read-back, so this
    // runtime cannot honestly claim it can rehydrate a sealed page, and the adapter fails closed
    // with RESUME_PAGE_SOURCE_REQUIRED rather than pretending. See the limitation note on
    // `collectPublicEvidence`.
  });
}

function checkpointKey({ source, operationId, boundLocationId, scopeHash, resumeCursor }) {
  return canonicalJson({
    boundLocationId,
    operationId,
    resumeCursor: resumeCursor ?? null,
    scopeHash,
    source,
  });
}

/**
 * The scope checkpoint store. Every checkpoint the adapter saves is kept and then travels OUT of
 * collection inside the public evidence, so the kernel writes it into the encrypted
 * `collecting_public` phase artefact along with everything else it collected — durable, at rest,
 * under the same key, with no second SQLite handle and no store of its own.
 *
 * It cannot be the RUN-scoped checkpoint table: `state.saveCheckpoint` requires an existing run
 * row (`RUN_NOT_FOUND`), and collection here necessarily happens BEFORE `createRun` because
 * `privateSourceInventoryHash` is a frozen input and can only be computed from envelopes that
 * already exist.
 */
function scopeCheckpointStore() {
  const records = new Map();
  return {
    records,
    async save(checkpoint) {
      records.set(checkpointKey(checkpoint), JSON.parse(canonicalJson(checkpoint)));
    },
    async load(query) {
      const found = records.get(checkpointKey(query));
      return found === undefined ? undefined : JSON.parse(canonicalJson(found));
    },
    list() {
      return [...records.values()]
        .sort((left, right) => (
          canonicalJson(left) < canonicalJson(right) ? -1 : 1
        ));
    },
  };
}

function publicCollectionPlan(config) {
  return planWeeklyCollection({
    // Identical arguments to the ones `lib/kernel.mjs` uses at preflight (with no governed
    // baseline, which this rail does not supply), so the window collected here is the window the
    // run reports.
    cutoff: new Date(config.frozenInputs.cutoff).toISOString(),
    timezone: config.frozenInputs.timezone,
    salesCycleDays: config.salesCycleDays,
    providerAvailableFrom: config.providerAvailableFrom,
    lateArrivalHours: Math.max(
      72,
      Number.isFinite(config.lateArrivalHours) ? config.lateArrivalHours : 72,
    ),
  });
}

/**
 * The declared capabilities, resolved against the TRUSTED policy rather than against themselves.
 * A configuration names only `{operationId, actionId}`; the method, path, category, risk,
 * snapshot hash and allowlist hash are taken from the checked-in allowlist, so a configuration
 * cannot state a tuple the catalog does not agree with — and a catalog that is being extended
 * elsewhere is picked up without touching this file.
 */
function approvedPublicCapabilities(config) {
  const policy = loadTrustedPublicReadPolicy();
  if (
    config.publicCatalogSnapshotHash !== policy.snapshotHash
    || config.publicReadAllowlistHash !== policy.allowlistHash
  ) throw codedError('AUDIT_PREFLIGHT_FAILED_PUBLIC_POLICY');
  const listed = new Map(policy.allowlist.actions.map((action) => [action.actionId, action]));
  return Object.freeze(config.capabilities.map(({ operationId, actionId }) => {
    const action = listed.get(actionId);
    if (!action || action.risk !== 'read') {
      throw codedError('AUDIT_PREFLIGHT_FAILED_PUBLIC_CAPABILITY');
    }
    return Object.freeze({
      operationId,
      actionId: action.actionId,
      method: action.method,
      normalizedPath: action.normalizedPath,
      category: action.category,
      risk: action.risk,
      sourceSnapshotHash: policy.snapshotHash,
      allowlistHash: policy.allowlistHash,
      providerId: config.providerId,
      capabilityManifestHash: config.capabilityManifestHash,
    });
  }));
}

function sortedPrivateSourceInventory(entries) {
  const sorted = [...entries].sort((left, right) => {
    if (left.sourceId === right.sourceId) return 0;
    return left.sourceId < right.sourceId ? -1 : 1;
  });
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].sourceId === sorted[index - 1].sourceId) {
      throw codedError('AUDIT_PREFLIGHT_FAILED_PRIVATE_SOURCE_INVENTORY');
    }
  }
  if (sorted.length === 0) {
    // Every scope came back incomplete, so this run has NO authoritative source at all. The
    // frozen inputs would be unsealable (`lib/state.mjs` requires a non-empty inventory) and a
    // run created on them would be claiming an authority it does not have. Fail closed, loudly,
    // before any run row exists.
    throw codedError('AUDIT_PREFLIGHT_FAILED_PRIVATE_SOURCE_INVENTORY');
  }
  return sorted;
}

/**
 * ONE bounded public collection: connect, collect every approved capability, and hand back both
 * the evidence and the frozen-input half that only the collection can know.
 *
 * Boundedness is the adapter's, unchanged: each `collect` paginates to a terminal page or returns
 * an INCOMPLETE result with a stable reason and a saved checkpoint. A budget-exhausted scope is
 * therefore `complete_partial` with a resume cursor, never a throw. This runtime does not re-enter
 * `collect` with that cursor: every reason the adapter can emit is either a budget bound (where
 * continuing would void the bound the profile exists to impose) or an integrity/coverage signal
 * (`CURSOR_LOOP`, `REPORTED_COUNT_CHANGED`, `APPLIED_WINDOW_CHANGED`, `TRUNCATED`,
 * `TERMINAL_PROOF_MISSING`, `RATE_LIMITED`), where continuing would paper over the very thing the
 * reason exists to report. The cursor is checkpointed for a human-gated continuation instead.
 */
async function collectPublicEvidence({
  config,
  projectRoot,
  vaultKeyReference,
  transportConnect,
  ghlNativeConnect,
  credentialResolver,
  keyProvider,
  signal,
  runtime,
}) {
  validatePublicConfig(config);
  const locationId = config.expectedLocationId;
  /**
   * The GHL TRANSLATION seam.
   *
   * `transportConnect` keeps its exact existing meaning: a host-owned connect whose delegate
   * ALREADY speaks the bounded adapter's normalised dialect. `ghlNativeConnect` is the new one: a
   * host-owned connect whose delegate is a RAW GHL MCP client, which is what a real sub-account is
   * actually reachable through. Only the second is wrapped in the translator, so nothing that
   * exists today changes shape, and a host must say explicitly which kind of client it owns rather
   * than the runtime guessing from a response it has not received yet.
   *
   * The capability preflight runs HERE, before any transport is connected, so a configuration that
   * names an approved-but-untranslated read (`payments-v3__*`) or one that cannot be driven from
   * `{locationId, fromDate, toDate}` alone fails with a clear code and makes no live call at all.
   */
  if (transportConnect !== null && ghlNativeConnect !== null) {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  }
  /**
   * The DEFAULT GHL-native session — the last missing piece. Nothing in this repo could construct
   * a real GHL MCP session: `connectMcp`'s `defaultConnect` sends `Authorization: Bearer`, which
   * no GHL worker accepts, and `ghlNativeConnect` had no default, so a live run required a host to
   * bring its own client. A configuration that DECLARES the native transport now gets
   * `lib/adapters/ghl-native-session.mjs` built for it, from a credential REFERENCE only.
   *
   * The seam stays injectable and injection stays authoritative: a host-supplied
   * `ghlNativeConnect` is used as-is whatever the configuration declares, which is why every
   * hermetic test in `tests/ghl-public-translator.test.mjs` is untouched by this. And a
   * configuration that declares a native server while the host injects a NORMALISED
   * `transportConnect` is a contradiction about what is on the other end of the wire, so it is
   * refused rather than resolved by precedence.
   */
  const nativeTransport = config.transport.kind === GHL_NATIVE_TRANSPORT_KIND
    ? validateGhlNativeTransport(config.transport)
    : null;
  if (nativeTransport !== null && transportConnect !== null) {
    throw codedError('AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG');
  }
  const nativeConnect = ghlNativeConnect ?? (nativeTransport === null ? null : createGhlNativeConnect({
    url: nativeTransport.url,
    credentialHeaderName: nativeTransport.credentialHeaderName,
    // A host may instrument the wire (a hermetic test does exactly this). A provider
    // configuration cannot: `validateGhlNativeTransport` refuses a `fetch` key outright.
    fetch: typeof runtime?.ghlNativeFetch === 'function' ? runtime.ghlNativeFetch : undefined,
  }));
  if (nativeConnect !== null) assertTranslatableCapabilities(config.capabilities);
  const effectiveConnect = nativeConnect === null
    ? transportConnect
    : createGhlTranslatingConnect({ connect: nativeConnect, runtime });
  const capabilities = approvedPublicCapabilities(config);
  const plan = publicCollectionPlan(config);
  const window = Object.freeze({
    from: new Date(plan.collectionStart).toISOString(),
    to: new Date(plan.cutoff).toISOString(),
  });
  const retentionDays = Number.isSafeInteger(config.rawEvidenceRetentionDays)
    ? config.rawEvidenceRetentionDays
    : PUBLIC_DEFAULT_RETENTION_DAYS;
  const expiresAt = new Date(
    config.frozenInputs.cutoff + retentionDays * PUBLIC_DAY_MS,
  ).toISOString();

  const keys = publicKeyMaterial(vaultKeyReference, { keyProvider });
  // `openVault` takes ownership and zeroes what it is handed, which is why this is a SEPARATE
  // resolution from the one the kernel holds for phase encryption.
  const vault = openVault({
    paths: auditPaths(projectRoot, locationId),
    encryptionKey: keys.encryptionKey,
    pseudonymKey: keys.pseudonymKey,
  });
  const checkpointStore = scopeCheckpointStore();
  const rawPageSink = vaultRawPageSink(vault, expiresAt);
  const allowlist = loadPublicReadAllowlist();
  let client;
  try {
    if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
    // `mcp-transport.mjs` `validateTransport` knows two kinds and exactly four keys. The
    // GHL-native record is therefore reduced to the streamable-http transport it IS before it
    // crosses that boundary — the header name is already baked into `effectiveConnect`, and the
    // URL is re-validated on the far side by rules identical to the ones it already passed.
    const wireTransport = nativeTransport === null
      ? structuredClone(config.transport)
      : { kind: 'streamable-http', url: nativeTransport.url };
    client = await connectMcp({
      transport: effectiveConnect === null
        ? wireTransport
        : { ...wireTransport, connect: effectiveConnect },
      // EXACTLY the six keys `lib/adapters/mcp-transport.mjs` accepts. `credentialRef` is copied
      // through as the reference it is; its VALUE is resolved inside the transport and never
      // returned to, held by, or logged by this runtime.
      providerConfig: {
        providerId: config.providerId,
        expectedLocationId: locationId,
        capabilityManifestHash: config.capabilityManifestHash,
        publicCatalogSnapshotHash: config.publicCatalogSnapshotHash,
        publicReadAllowlistHash: config.publicReadAllowlistHash,
        credentialRef: config.credentialRef === null
          ? null
          : structuredClone(config.credentialRef),
      },
      ...(credentialResolver === null ? {} : { credentialResolver }),
    });

    const scopes = [];
    const envelopes = [];
    const inventory = [];
    const limitations = [];
    for (const capability of capabilities) {
      if (signal?.aborted) throw codedError('COLLECTION_ABORTED');
      const adapter = createPublicGhlAdapter({
        client,
        allowlist,
        expectedLocationId: locationId,
        // Undefined on purpose: the adapter then loads the versioned per-category budgets from
        // `profiles/collection-budgets.v1.json`, which is the only place they may come from.
        budgets: undefined,
        checkpointStore,
        rawPageSink,
        runtime,
      });
      const result = await adapter.collect({
        capability,
        window,
        cursor: null,
        signal,
      });
      const complete = result.page.complete === true
        && !Object.hasOwn(result, 'incompleteReason');
      if (complete) {
        envelopes.push(JSON.parse(canonicalJson(result.privateSourceEnvelope)));
        inventory.push(...result.privateSourceInventory.map(
          (entry) => JSON.parse(canonicalJson(entry)),
        ));
      } else {
        limitations.push({
          operationId: capability.operationId,
          reason: result.incompleteReason ?? 'PUBLIC_SCOPE_INCOMPLETE',
          resumeCursor: result.page.nextCursor,
        });
      }
      scopes.push({
        operationId: capability.operationId,
        actionId: capability.actionId,
        category: capability.category,
        status: complete ? 'complete' : 'complete_partial',
        incompleteReason: result.incompleteReason ?? null,
        requestedWindow: JSON.parse(canonicalJson(result.requestedWindow)),
        appliedWindow: JSON.parse(canonicalJson(result.appliedWindow)),
        capturedAt: result.capturedAt,
        page: JSON.parse(canonicalJson(result.page)),
        items: JSON.parse(canonicalJson(result.items)),
      });
    }

    const privateSourceInventory = sortedPrivateSourceInventory(inventory);
    const publicEvidence = {
      schemaVersion: LOCAL_SCHEMA,
      source: PUBLIC_SOURCE,
      boundLocationId: locationId,
      collectionWindow: { from: window.from, to: window.to },
      collectionMode: plan.mode,
      // Present and empty so the kernel's late-event merge sees the shape it expects when a
      // governed baseline is later supplied.
      events: [],
      scopes: scopes.sort((left, right) => (
        left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0
      )),
      privateSourceEnvelopes: envelopes.sort((left, right) => (
        left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
      )),
      scopeCheckpoints: checkpointStore.list(),
      limitations: limitations.sort((left, right) => (
        left.operationId < right.operationId ? -1 : 1
      )),
    };
    return Object.freeze({
      publicEvidence,
      privateSourceInventory,
      privateSourceInventoryHash: sha256(privateSourceInventory),
      collectionPlan: plan,
    });
  } finally {
    try {
      await client?.close?.();
    } catch {
      // A transport that cannot be closed cleanly must not mask the collection's own outcome.
    }
    vault.close();
  }
}

/**
 * A RESUME must not re-collect, and cannot.
 *
 * `privateSourceInventory` entries hash an envelope that contains `capturedAt`, so two
 * collections of a byte-identical account produce two different `privateSourceInventoryHash`
 * values. A resume that re-collects therefore ALWAYS fails `assertResumeInputs`, the kernel
 * restarts it as a new run, and while the suspended run still holds its lease the operator gets
 * `RESUME_INPUT_MISMATCH_ACTIVE_LEASE` — i.e. an `awaiting_model_review` public run could never
 * be finished. Re-collecting would also re-read the live account for a run whose evidence is
 * already durable, which is exactly what a resume exists to avoid.
 *
 * So a resume ADOPTS the inventory the run was already sealed with, and only when the run's own
 * public evidence is durably checkpointed, so the adopted inventory always describes evidence
 * that exists. Every other case returns `null` and the caller collects, which is an honest
 * `RESUME_INPUT_MISMATCH` restart.
 */
function adoptSealedInventory({ projectRoot, locationId, runId, declared }) {
  let state;
  try {
    state = openState({ projectRoot, locationId });
  } catch {
    return null;
  }
  try {
    const sealed = state.getRun(runId)?.frozenInputs;
    if (!isPlainObject(sealed)) return null;
    // Without a durable `collecting_public` artefact the kernel would call `collectPublic` for
    // real, and a fresh collection can never match an adopted inventory.
    if (state.getCheckpoint({ runId, phase: 'collecting_public' }) === undefined) return null;
    const { privateSourceInventory, privateSourceInventoryHash, ...rest } = sealed;
    // Everything the CONFIGURATION states must still be what the run was sealed with. A changed
    // configuration is a different audit and must restart rather than inherit an authority.
    if (canonicalJson(rest) !== canonicalJson(declared)) return null;
    if (
      !Array.isArray(privateSourceInventory)
      || privateSourceInventory.length === 0
      || sha256(privateSourceInventory) !== privateSourceInventoryHash
    ) return null;
    return {
      privateSourceInventory: structuredClone(privateSourceInventory),
      privateSourceInventoryHash,
    };
  } catch {
    return null;
  } finally {
    state?.close();
  }
}

/**
 * The public kernel.
 *
 * Ordering is forced by the frozen-input contract: `privateSourceInventoryHash` is sealed into
 * the run at `createRun`, and it can only be computed from envelopes that already exist, so the
 * collection runs inside `freezeInputs` and is MEMOISED for the `collecting_public` phase that
 * follows. One logical run therefore performs exactly one public collection.
 *
 * `collectInternal` is absent: this rail is public-only, so the run carries the two internal
 * limitations and is honestly `complete_partial`, exactly as the offline rail is.
 */
/**
 * THE INTERNAL RAIL, OWNING ITS OWN SESSION LIFETIME.
 *
 * `collectInternalEvidencePhase` calls `collectAuditEvidence` once and has no notion of closing a
 * transport. So the session is opened INSIDE that call and closed in its `finally`, which means a
 * run that suspends at the auth boundary, latches its circuit, or throws does not leave a child
 * process behind. A kernel-level open would have to be torn down by the kernel, and the kernel
 * neither knows about transports nor should.
 */
function buildInternalAuditAdapter({ internalAudit, expectedLocationId, connectOverride, runtime }) {
  if (!isPlainObject(internalAudit)) return null;
  const connect = connectOverride ?? createInternalAuditConnect({
    serverPath: internalAudit.transport.serverPath,
    tokenFilePath: internalAudit.transport.tokenFilePath,
  });
  return {
    async collectAuditEvidence(request) {
      const client = await connect();
      try {
        const collector = createInternalAuditCollector({
          rail: createInternalAuditAdapter({ client, expectedLocationId }),
          boundLocationId: expectedLocationId,
          companyId: internalAudit.companyId,
          runtimeWorkflowIds: internalAudit.runtimeWorkflowIds ?? [],
          budgets: internalAudit.budgets ?? {},
          runtime,
        });
        // AWAITED, and it has to be. `return collector.collectAuditEvidence(request)` hands the
        // pending promise out of the `try`, so the `finally` below closes the session while the
        // collection is still on its first call. Against a hermetic double that only reorders a
        // log; against a real transport every read after the credential check happens on a closed
        // child process. A test asserting the call ORDER caught it, which an outcome-only test
        // could not have.
        return await collector.collectAuditEvidence(request);
      } finally {
        try {
          await client.close?.();
        } catch {
          // A transport that will not close cleanly must not mask the collection's own outcome.
        }
      }
    },
  };
}

export function createPublicAuditKernel({
  initialRunId,
  // Set by the CLI's `resume` command, which is the only caller that knows which run is being
  // resumed — the kernel does not pass a run id to `freezeInputs`.
  resumeRunId = null,
  transportConnect = null,
  // A host-owned connect whose delegate is a RAW GHL MCP client. Mutually exclusive with
  // `transportConnect`; see `collectPublicEvidence`.
  ghlNativeConnect = null,
  // A host-owned connect to the INTERNAL audit server. When supplied it wins over whatever the
  // configuration declares, exactly as `ghlNativeConnect` does, so a hermetic test never launches
  // a child process and never needs the plugin installed.
  internalAuditConnect = null,
  credentialResolver = null,
  keyProvider = null,
  signal = null,
  runtime = {},
} = {}) {
  let nextRunId = initialRunId;
  let memo = null;
  let adopted = null;
  /*
   * Where this run's analysis artefacts belong, captured at `freezeInputs` because the kernel does
   * not pass `projectRoot` to `normalize` and the briefs have to land under the account's own audit
   * root rather than wherever the process happens to be. Stays `null` until a run is sealed, so a
   * kernel that never froze inputs writes nothing.
   */
  let analysisTarget = null;
  // Consumed on the FIRST `freezeInputs`, which is the resume's own. `kernel.resume` restarts a
  // mismatched run by calling `start` in the same kernel, and that new run must collect for
  // itself rather than adopting the authority of the run it is replacing.
  let pendingResumeRunId = resumeRunId;
  const collectionFor = async (args) => {
    const config = validatePublicConfig(args.providerConfig);
    const key = sha256({
      configHash: sha256(config),
      locationId: config.expectedLocationId,
      projectRoot: resolve(args.projectRoot),
      vaultKeyReference: sha256(args.vaultKeyReference ?? null),
    });
    if (memo === null || memo.key !== key) {
      memo = {
        key,
        collection: collectPublicEvidence({
          config,
          projectRoot: args.projectRoot,
          vaultKeyReference: args.vaultKeyReference,
          transportConnect,
          ghlNativeConnect,
          credentialResolver,
          keyProvider,
          signal,
          runtime,
        }),
      };
    }
    return memo.collection;
  };
  return createAuditKernel({
    clock: () => Date.now(),
    idFactory: () => {
      const selected = nextRunId ?? `run_${randomUUID()}`;
      nextRunId = undefined;
      return selected;
    },
    keyResolver: (reference) => publicKeyMaterial(reference, { keyProvider }),
    stateStore: { open: openState },
    providerConfigLoader: loadPublicProjectConfig,
    adapters: {
      collectContext: async ({ providerConfig }) => (
        structuredClone(validatePublicConfig(providerConfig).context)
      ),
      collectPublic: async (args) => {
        // Reached only when the kernel could NOT restore the phase. Under an adopted inventory
        // there is no evidence this runtime may produce that the sealed inventory describes, so
        // it fails closed instead of collecting something the run is not sealed for.
        if (adopted !== null) throw codedError('AUDIT_PREFLIGHT_FAILED_PUBLIC_EVIDENCE_UNAVAILABLE');
        return (await collectionFor(args)).publicEvidence;
      },
      /**
       * Returns `null` -- the byte-identical public-only path every existing configuration takes
       * -- unless the configuration declares an internal rail. No credential is read here and no
       * network access is introduced by this wiring: the session opens inside
       * `collectAuditEvidence` and the GHL token is never handled by this process at all, because
       * the audit server reads it from a file whose PATH the transport record names.
       */
      collectInternal: async (args) => {
        const config = validatePublicConfig(args.providerConfig);
        if (!Object.hasOwn(config, 'internalAudit')) return null;
        return buildInternalAuditAdapter({
          internalAudit: config.internalAudit,
          expectedLocationId: config.expectedLocationId,
          connectOverride: internalAuditConnect,
          runtime,
        });
      },
    },
    analyzer: {
      freezeInputs: async (args) => {
        const config = validatePublicConfig(args.providerConfig);
        const declared = structuredClone(config.frozenInputs);
        analysisTarget = {
          projectRoot: resolve(args.projectRoot),
          locationId: config.expectedLocationId,
        };
        const resumingRunId = pendingResumeRunId;
        pendingResumeRunId = null;
        adopted = resumingRunId === null
          ? null
          : adoptSealedInventory({
            projectRoot: resolve(args.projectRoot),
            locationId: config.expectedLocationId,
            runId: resumingRunId,
            declared,
          });
        if (adopted !== null) return { ...declared, ...structuredClone(adopted) };
        const collection = await collectionFor(args);
        return {
          ...declared,
          privateSourceInventory: structuredClone(collection.privateSourceInventory),
          privateSourceInventoryHash: collection.privateSourceInventoryHash,
        };
      },
      /**
       * A3 — the measurement chain, in-process at last.
       *
       * This used to return two hashes, which is why a live run could collect 588 real records and
       * publish an empty report: `projectJourneyEvents -> normalizeEvidence -> buildEvidenceGraph
       * -> buildWindows -> computeJourneyMetrics` was exported, tested, and reachable only from a
       * script outside the repo.
       *
       * The two hashes are KEPT. They are what the offline rail returns, what the Task 10 shape
       * declares, and what a resume compares, so they stay first and stay byte-identical; the
       * measurement is added beside them.
       */
      normalize: async ({
        context,
        publicEvidence,
        internalEvidence,
        frozenInputs,
        runId,
      }) => {
        const measurement = measurePublicEvidence({ publicEvidence, frozenInputs });
        /*
         * THE SEAM. The three briefs and the three analyst prompts are written to disk HERE, where
         * the measurement and the internal evidence are both in hand, and they are deliberately NOT
         * added to this function's return value.
         *
         * Two reasons, both load-bearing. The checkpoint bytes stay exactly what the approved shape
         * declares, so a run sealed before this change still resumes. And `assertSafeCollected`
         * scans whatever `normalize` returns; a brief carries quoted message copy on purpose, which
         * is the one thing that scanner exists to keep out of a phase payload.
         *
         * Writing is byte-compared (`writeOnce`), so a restored `normalizing` checkpoint and a fresh
         * one leave identical files, and a mismatch stops the run instead of overwriting quietly.
         */
        if (analysisTarget !== null) {
          prepareAnalysisArtifacts({
            paths: auditPaths(analysisTarget.projectRoot, analysisTarget.locationId),
            runId,
            measurement,
            internal: internalEvidence ?? null,
          });
        }
        return {
          contextHash: sha256(context),
          publicEvidenceHash: sha256(publicEvidence),
          measurement,
        };
      },
      discover: async () => ({ findings: [] }),
      falsify: async () => ({ packets: [] }),
      loadMemory: async () => ({ events: [] }),
      createReviewRequests: async ({ providerConfig }) => (
        structuredClone(validatePublicConfig(providerConfig).reviews)
      ),
      prioritize: async ({ discovery, falsification, reviews }) => ({
        discovery,
        falsification,
        reviewHashes: reviews.map((review) => sha256(review)).sort(),
      }),
      compile: async () => ({
        status: 'complete_partial',
        coverage: {
          state: 'complete_partial',
          scope: 'public_comparable_subset',
          limitations: [...INTERNAL_LIMITATIONS],
        },
        diff: { state: 'FIRST_BASELINE', transitions: [] },
        findings: [],
      }),
    },
    verifier: async ({ compiled }) => {
      const limitations = new Set(compiled?.coverage?.limitations ?? []);
      return {
        result: compiled?.status === 'complete_partial'
          && limitations.has(INTERNAL_LIMITATIONS[0])
          && limitations.has(INTERNAL_LIMITATIONS[1])
          ? 'pass'
          : 'fail',
      };
    },
    publisher: publicationPublisher(
      'This publication covers the public comparable subset only; no internal evidence was collected.',
    ),
  });
}

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
import { createInternalGhlAdapter } from './adapters/internal-ghl.mjs';
import { createAuditKernel, sealFrozenInputs } from './kernel.mjs';
import { openState } from './state.mjs';

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

function localPublisher({
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
    'This offline fixture publication covers the public comparable subset only.',
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
}

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

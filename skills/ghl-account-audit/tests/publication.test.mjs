import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import {
  ingestPrivateSourceBundle,
  publishAtomically,
  sanitizeForPublication,
} from '../lib/artifacts.mjs';
import { auditPaths } from '../lib/paths.mjs';
import { openState } from '../lib/state.mjs';
import { openVault } from '../lib/vault.mjs';

const frozenInputs = Object.freeze({
  locationId: 'L1',
  cutoff: 1000,
  timezone: 'Australia/Sydney',
  contextHash: 'a',
  coverageProfileHash: 'b',
  metricProfileHash: 'metric-1',
  rulesetHash: 'c',
  codeHash: 'code-1',
  auditProfileHash: 'profile-1',
  providerToolProfileHash: 'provider-1',
  windowDefinitionsHash: 'windows-1',
  collectionBudgetHash: 'budget-1',
  capabilityProofIndexHash: 'proof-index-1',
  capabilityReceiptHashes: ['receipt-1'],
  capabilityAttestationHashes: ['attestation-1'],
  capabilityProofExpiries: [2000],
  capabilityManifestHashes: ['manifest-1'],
  target: {
    targetKind: 'location',
    operatingProfile: 'client',
    locationId: 'L1',
  },
});
const DEFAULT_SOURCES = Object.freeze([Object.freeze({
  sourceId: 'run-source',
  kind: 'private-content',
  payload: Object.freeze({ marker: 'authoritative-source-record' }),
})]);

function withProject(callback) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-audit-publication-'));
  try {
    return callback({ projectRoot, paths: auditPaths(projectRoot, 'L1') });
  } finally {
    const makeWritable = (directory) => {
      if (!existsSync(directory)) return;
      chmodSync(directory, 0o700);
      for (const name of readdirSync(directory)) {
        const child = join(directory, name);
        if (statSync(child).isDirectory()) makeWritable(child);
        else chmodSync(child, 0o600);
      }
    };
    makeWritable(projectRoot);
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function trustedRegistry(runManifest, sources, {
  paths: suppliedPaths,
  finalizeOptions,
  inspectCheckpoint,
  expectedSources = sources,
} = {}) {
  const ownsProject = !suppliedPaths;
  const projectRoot = ownsProject
    ? mkdtempSync(join(tmpdir(), 'ghl-audit-authority-'))
    : suppliedPaths.project;
  const paths = suppliedPaths ?? auditPaths(projectRoot, 'L1');
  const state = openState({ projectRoot, locationId: 'L1' });
  const vault = openVault({
    paths,
    encryptionKey: Buffer.alloc(32, 81),
    pseudonymKey: Buffer.alloc(32, 82),
  });
  try {
    const privateSourceInventory = expectedSources
      .map((source) => ({
        sourceId: source.sourceId,
        kind: source.kind,
        sourceHash: sha256({ schemaVersion: '1.0.0', source }),
      }))
      .sort((left, right) => (
        left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
      ));
    state.createRun({
      runId: runManifest.runId,
      frozenInputs: {
        ...frozenInputs,
        privateSourceInventory,
        privateSourceInventoryHash: sha256(privateSourceInventory),
      },
      now: 1000,
    });
    const collector = vault.beginPrivateSourceCollection({
      state,
      runManifest,
    });
    for (const source of sources) collector.add(source);
    const authoritativeBundle = collector.finalize(finalizeOptions);
    inspectCheckpoint?.(state.getCheckpoint({
      runId: runManifest.runId,
      phase: 'private-source-inventory',
    }));
    return ingestPrivateSourceBundle(authoritativeBundle);
  } finally {
    vault.close();
    state.close();
    if (ownsProject) rmSync(projectRoot, { recursive: true, force: true });
  }
}

function sanitizeBundle(raw, sources = DEFAULT_SOURCES, paths) {
  const registry = trustedRegistry(raw.runManifest, sources, { paths });
  return sanitizeForPublication(raw, {
    pseudonymKey: Buffer.alloc(32, 9),
    registry,
  });
}

function testVerifier({ publicationDir }) {
  const manifest = JSON.parse(readFileSync(join(publicationDir, 'run-manifest.json'), 'utf8'));
  return Object.freeze({
    verifierVersion: 'test-only',
    result: 'pass',
    manifestHash: sha256(manifest),
    publicationRoot: manifest.publicationRoot,
  });
}

function publishFixture(paths, overrides = {}) {
  const publication = sanitizeBundle({
    runManifest: {
      schemaVersion: '1.0.0',
      runId: 'run-2026-W30',
      publicationId: 'pub-full',
      week: '2026-W30',
      status: 'complete_full',
      ...overrides,
    },
    payloadArtifacts: {
      'REPORT.md': '# Weekly audit\n',
      'coverage.json': { status: 'complete' },
      'metrics-and-findings.json': { findings: [] },
    },
    verifierAttestation: {
      verifierVersion: '1.0.0',
      result: 'pass',
    },
    projections: {},
  }, DEFAULT_SOURCES, paths);
  return publishAtomically({ paths, ...publication, verifyPublication: testVerifier });
}

test('manifest root excludes the manifest and verifier to avoid circular hashing', () => withProject(({ paths }) => {
  const publication = publishFixture(paths);
  assert.deepEqual(
    publication.rootMembers.sort(),
    ['REPORT.md', 'coverage.json', 'metrics-and-findings.json'].sort(),
  );
  assert.equal(publication.attestation.manifestHash, sha256(publication.manifest));
  assert.equal(publication.attestation.publicationRoot, publication.manifest.publicationRoot);
  assert.equal(
    JSON.parse(readFileSync(join(publication.path, 'run-manifest.json'), 'utf8')).publicationRoot,
    publication.manifest.publicationRoot,
  );
}));

test('publication is renamed from staging, immutable, and projection writes are atomic', () => withProject(({ paths }) => {
  const publication = publishFixture(paths);
  assert.equal(existsSync(publication.path), true);
  assert.equal(statSync(publication.path).mode & 0o222, 0);
  for (const member of [...publication.rootMembers, 'run-manifest.json', 'verifier-attestation.json']) {
    assert.equal(statSync(join(publication.path, member)).mode & 0o222, 0, member);
  }
  assert.equal(
    readFileSync(join(paths.root, 'CURRENT.md'), 'utf8'),
    '# Current GHL audit\n\n[Open the latest publication](weekly/2026-W30/pub-full/REPORT.md)\n',
  );
  const index = JSON.parse(readFileSync(join(paths.root, 'index.json'), 'utf8'));
  assert.equal(index.latest.publicationId, 'pub-full');
  assert.equal(index.latestFull.publicationId, 'pub-full');
  assert.deepEqual(index.publications.map(({ publicationId }) => publicationId), ['pub-full']);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(join(publication.path, 'run-manifest.json'), 'utf8'))).sort(),
    Object.keys(publication.manifest).sort(),
  );
  assert.equal(
    readFileSync(join(publication.path, 'run-manifest.json'), 'utf8'),
    `${canonicalJson(publication.manifest)}\n`,
  );
}));

test('partial publication updates current but never overwrites latest-full', () => withProject(({ paths }) => {
  publishFixture(paths);
  const partial = publishFixture(paths, {
    runId: 'run-partial',
    publicationId: 'pub-partial',
    status: 'complete_partial',
  });
  const index = JSON.parse(readFileSync(join(paths.root, 'index.json'), 'utf8'));
  assert.equal(index.latest.publicationId, 'pub-partial');
  assert.equal(index.latestFull.publicationId, 'pub-full');
  assert.equal(index.publications.length, 2);
  assert.match(readFileSync(join(paths.root, 'CURRENT.md'), 'utf8'), /pub-partial/u);
  assert.equal(partial.manifest.status, 'complete_partial');
}));

test('publication refuses private values before creating publishable artifacts', () => withProject(({ paths }) => {
  assert.throws(
    () => publishAtomically({
      paths,
      runManifest: {
        runId: 'private-run',
        publicationId: 'private-publication',
        week: '2026-W30',
        status: 'complete_partial',
      },
      payloadArtifacts: {
        'REPORT.md': 'Contact ava.private@example.invalid or use Bearer private-authorization-canary',
      },
      verifierAttestation: { result: 'pass' },
    }),
    (error) => error.code === 'PUBLICATION_BOUNDARY_REQUIRED'
      && !String(error.stack).includes('ava.private@example.invalid')
      && !String(error.stack).includes('private-authorization-canary'),
  );
  assert.equal(existsSync(paths.root), false);
}));

test('publication rejects unsafe paths and idempotently verifies an immutable publication', () => withProject(({ paths }) => {
  assert.throws(
    () => {
      const unsafe = sanitizeBundle({
      runManifest: {
        runId: 'unsafe',
        publicationId: 'unsafe-publication',
        week: '2026-W30',
        status: 'complete_partial',
      },
      payloadArtifacts: { '../escape.json': {} },
      verifierAttestation: { result: 'pass' },
      projections: {},
      });
      publishAtomically({ paths, ...unsafe, verifyPublication: testVerifier });
    },
    /INVALID_ARTIFACT_PATH/u,
  );
  publishFixture(paths);
  assert.equal(publishFixture(paths).recovered, true);
}));

test('backlog projections are atomically copied outside the immutable publication', () => withProject(({ paths }) => {
  const input = sanitizeBundle({
    runManifest: {
      runId: 'projection-run',
      publicationId: 'projection-publication',
      week: '2026-W30',
      status: 'complete_partial',
    },
    payloadArtifacts: {
      'REPORT.md': '# Report\n',
      'metrics-and-findings.json': { findings: [] },
    },
    verifierAttestation: { result: 'pass' },
    projections: {
      'BACKLOG.md': '# Backlog\n',
      'backlog.json': { entries: [] },
      'current-system-flow.mmd': 'flowchart LR\n  A --> B\n',
    },
  });
  const publication = publishAtomically({ paths, ...input, verifyPublication: testVerifier });
  assert.ok(publication.path.endsWith(join('2026-W30', 'projection-publication')));
  for (const name of ['BACKLOG.md', 'backlog.json', 'current-system-flow.mmd']) {
    assert.equal(existsSync(join(paths.root, 'memory', name)), true, name);
  }
  assert.equal(publication.rootMembers.includes('BACKLOG.md'), false);
}));

test('trusted source ingestion derives a complete opaque registry and preserves non-private proposal copy', () => {
  const uniqueName = 'Unique Private Person Canary';
  const uniqueTranscript = 'Prefix private transcript excerpt appears nowhere else suffix.';
  const transcriptExcerpt = 'private transcript excerpt appears nowhere else';
  const safeIdPrivateValue = 'ev_1234567890abcdef';
  const safePseudonymPrivateValue = `psn_${'a'.repeat(32)}`;
  const runManifest = {
    runId: 'registry-run',
    publicationId: 'registry-publication',
    week: '2026-W30',
    status: 'complete_partial',
  };
  assert.throws(
    () => ingestPrivateSourceBundle({ runManifest, sources: [] }),
    /PRIVATE_SOURCE_AUTHORITY_REQUIRED/u,
  );
  assert.throws(
    () => trustedRegistry(runManifest, []),
    /INVALID_FROZEN_INPUTS/u,
  );
  assert.throws(
    () => ingestPrivateSourceBundle({
      runManifest,
      sources: [],
      complete: true,
    }),
    /PRIVATE_SOURCE_AUTHORITY_REQUIRED/u,
  );
  const fixture = {
    runManifest,
    finding: {
      summary: `${uniqueName} reported a private conversation.`,
      transcriptExcerpt,
      actorRef: safeIdPrivateValue,
      contactRef: safePseudonymPrivateValue,
    },
    conversation: {
      transcript: uniqueTranscript,
    },
    proposal: {
      changeSet: {
        current: { copy: 'Keep this exact non-private proposal structure.' },
        proposed: { copy: `Sanitized replacement for ${uniqueName}` },
      },
    },
  };
  assert.throws(
    () => sanitizeForPublication(fixture, {
      pseudonymKey: Buffer.alloc(32, 9),
    }),
    /PRIVATE_SOURCE_REGISTRY_REQUIRED/u,
  );
  for (const registry of [
    [],
    [{ source: 'contact_record', kind: 'pii', value: uniqueName }],
  ]) {
    assert.throws(
      () => sanitizeForPublication(fixture, {
        pseudonymKey: Buffer.alloc(32, 9),
        registry,
      }),
      /PRIVATE_SOURCE_REGISTRY_REQUIRED/u,
    );
  }
  const contactOnlySources = [{
      sourceId: 'contact-record-only',
      kind: 'pii',
      payload: { name: uniqueName },
  }];
  assert.throws(
    () => trustedRegistry(runManifest, [
      ...contactOnlySources,
      {
        sourceId: 'conversation-record-required',
        kind: 'private-content',
        payload: { message: uniqueTranscript },
      },
    ], {
      finalizeOptions: { sourceIds: ['contact-record-only'] },
    }),
    /PRIVATE_SOURCE_AUTHORITY_INVALID/u,
  );
  const incompleteRegistry = trustedRegistry(runManifest, contactOnlySources);
  assert.throws(
    () => sanitizeForPublication(fixture, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry: incompleteRegistry,
    }),
    /PRIVATE_SOURCE_REGISTRY_INCOMPLETE/u,
  );
  assert.throws(
    () => sanitizeForPublication({
      runManifest,
      finding: {
        summary: `${uniqueName} used omitted.private@example.invalid`,
      },
    }, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry: incompleteRegistry,
    }),
    /PRIVATE_SOURCE_REGISTRY_INCOMPLETE/u,
  );
  const registry = trustedRegistry(runManifest, [
      {
        sourceId: 'contact-record',
        kind: 'pii',
        payload: { name: uniqueName, opaqueIds: [safeIdPrivateValue, safePseudonymPrivateValue] },
      },
      {
        sourceId: 'conversation-record',
        kind: 'private-content',
        payload: { message: uniqueTranscript },
      },
    ], {
      inspectCheckpoint(checkpoint) {
        assert.equal(checkpoint.phase, 'private-source-inventory');
        assert.equal(checkpoint.payload.sourceRecordCount, 2);
        assert.equal(checkpoint.payload.sourceValueCount, 4);
        assert.match(checkpoint.payload.inventorySignature, /^[a-f0-9]{64}$/u);
      },
    });
  assert.equal(Object.isFrozen(registry), true);
  assert.deepEqual(Reflect.ownKeys(registry), []);
  assert.throws(
    () => sanitizeForPublication(fixture, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry,
      privateValues: [],
    }),
    /PRIVATE_SOURCE_REGISTRY_REQUIRED/u,
  );
  const sanitized = sanitizeForPublication(fixture, {
    pseudonymKey: Buffer.alloc(32, 9),
    registry,
  });
  const text = JSON.stringify(sanitized);
  assert.equal(text.includes(uniqueName), false);
  assert.equal(text.includes(uniqueTranscript), false);
  assert.equal(text.includes(transcriptExcerpt), false);
  assert.notEqual(sanitized.finding.actorRef, safeIdPrivateValue);
  assert.notEqual(sanitized.finding.contactRef, safePseudonymPrivateValue);
  assert.equal(
    sanitized.proposal.changeSet.current.copy,
    'Keep this exact non-private proposal structure.',
  );
  assert.match(sanitized.proposal.changeSet.proposed.copy, /psn_[a-f0-9]{32}/u);

  const normalizedRegistry = trustedRegistry(runManifest, [
    {
      sourceId: 'normalized-private-name',
      kind: 'pii',
      payload: { name: 'José   Alvarez' },
    },
    {
      sourceId: 'normalized-private-content',
      kind: 'private-content',
      payload: { note: 'Résumé   Call Notes' },
    },
  ]);
  for (const variant of [
    'JOSÉ ALVAREZ',
    'Jose\u0301 Alvarez',
    'José\t\nAlvarez',
    'RÉSUMÉ CALL NOTES',
    'Re\u0301sume\u0301 Call Notes',
    'Résumé\t\nCall Notes',
  ]) {
    const normalized = sanitizeForPublication({
      runManifest,
      finding: { summary: `Follow-up for ${variant}` },
    }, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry: normalizedRegistry,
    });
    assert.equal(JSON.stringify(normalized).includes(variant), false, variant);
  }

  const shortRegistry = trustedRegistry(runManifest, [{
      sourceId: 'short-private-value',
      kind: 'pii',
      payload: { initial: 'A' },
  }]);
  const shortSafe = sanitizeForPublication({
    runManifest,
    proposal: { copy: 'A safe proposal stays exactly as written.' },
  }, {
    pseudonymKey: Buffer.alloc(32, 9),
    registry: shortRegistry,
  });
  assert.equal(shortSafe.proposal.copy, 'A safe proposal stays exactly as written.');

  assert.throws(
    () => trustedRegistry(runManifest, [{
        sourceId: 'numeric-phone',
        kind: 'pii',
        payload: { phone: 61412345678 },
    }]),
    /PRIVATE_SOURCE_NON_STRING_VALUE/u,
  );

  const mismatched = trustedRegistry(
    { ...runManifest, runId: 'other-run' },
    DEFAULT_SOURCES,
  );
  assert.throws(
    () => sanitizeForPublication(fixture, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry: mismatched,
    }),
    /PRIVATE_SOURCE_REGISTRY_MISMATCH/u,
  );
});

test('durable expected source inventory rejects a selectively omitted transcript', () => {
  const runManifest = {
    runId: 'selective-omission-run',
    publicationId: 'selective-omission-publication',
    week: '2026-W30',
    status: 'complete_partial',
  };
  const benign = {
    sourceId: 'benign-source',
    kind: 'private-content',
    payload: { marker: 'benign marker' },
  };
  const transcript = {
    sourceId: 'required-transcript',
    kind: 'private-content',
    payload: { transcript: 'OMITTED PRIVATE TRANSCRIPT CANARY' },
  };
  let mintedRegistry;
  assert.throws(
    () => {
      mintedRegistry = trustedRegistry(runManifest, [benign], {
      expectedSources: [benign, transcript],
      });
    },
    /PRIVATE_SOURCE_INVENTORY_INCOMPLETE/u,
  );
  assert.equal(mintedRegistry, undefined);
});

test('sanitizer rescans mixed exact and normalized private variants', () => {
  const runManifest = {
    runId: 'mixed-variant-run',
    publicationId: 'mixed-variant-publication',
    week: '2026-W30',
    status: 'complete_partial',
  };
  const privateName = 'José Alvarez';
  const registry = trustedRegistry(runManifest, [{
    sourceId: 'private-name',
    kind: 'pii',
    payload: { name: privateName },
  }]);
  for (const mixed of [
    `${privateName} and JOSÉ ALVAREZ`,
    `${privateName} and Jose\u0301 Alvarez`,
    `${privateName} and José\t\nAlvarez`,
  ]) {
    const sanitized = sanitizeForPublication({
      runManifest,
      finding: { summary: mixed },
    }, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry,
    });
    const text = JSON.stringify(sanitized);
    assert.equal(text.includes('JOSÉ ALVAREZ'), false);
    assert.equal(text.includes('Jose\u0301 Alvarez'), false);
    assert.equal(text.includes('José\t\nAlvarez'), false);
  }
});

test('sanitizer removes private object keys and rejects sanitized collisions', () => {
  const runManifest = {
    runId: 'private-key-run',
    publicationId: 'private-key-publication',
    week: '2026-W30',
    status: 'complete_partial',
  };
  const privateKey = 'José Alvarez';
  const registry = trustedRegistry(runManifest, [{
    sourceId: 'private-object-key',
    kind: 'pii',
    payload: { name: privateKey },
  }]);
  const sanitized = sanitizeForPublication({
    runManifest,
    findingsByActor: {
      'JOSÉ ALVAREZ': { status: 'open' },
    },
  }, {
    pseudonymKey: Buffer.alloc(32, 9),
    registry,
  });
  assert.equal(Object.keys(sanitized.findingsByActor).includes('JOSÉ ALVAREZ'), false);
  assert.match(Object.keys(sanitized.findingsByActor)[0], /^psn_[a-f0-9]{32}$/u);

  assert.throws(
    () => sanitizeForPublication({
      runManifest,
      findingsByActor: {
        'José Alvarez': { status: 'open' },
        'JOSÉ ALVAREZ': { status: 'closed' },
      },
    }, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry,
    }),
    /PUBLICATION_KEY_COLLISION/u,
  );
  assert.throws(
    () => sanitizeForPublication({
      runManifest,
      findingsByActor: JSON.parse('{"__proto__":{"polluted":true}}'),
    }, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry,
    }),
    /PUBLICATION_KEY_FORBIDDEN/u,
  );
});

test('publisher accepts only one non-forgeable sanitized bundle and allowlisted artifact schemas', () => withProject(({ paths }) => {
  const raw = {
    runManifest: {
      runId: 'boundary-run',
      publicationId: 'boundary-publication',
      week: '2026-W30',
      status: 'complete_partial',
    },
    payloadArtifacts: {
      'REPORT.md': '# Safe report\n',
      'metrics-and-findings.json': { evidenceRefs: ['ev_1234567890abcdef'] },
    },
    verifierAttestation: { result: 'pass' },
    projections: {},
  };
  assert.throws(() => publishAtomically({ paths, ...raw }), /PUBLICATION_BOUNDARY_REQUIRED/u);

  const separateRegistry = trustedRegistry(raw.runManifest, DEFAULT_SOURCES, { paths });
  const separatelySanitized = {
    runManifest: sanitizeForPublication(raw.runManifest, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry: separateRegistry,
      runManifest: raw.runManifest,
    }),
    payloadArtifacts: sanitizeForPublication(raw.payloadArtifacts, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry: separateRegistry,
      runManifest: raw.runManifest,
    }),
    verifierAttestation: sanitizeForPublication(raw.verifierAttestation, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry: separateRegistry,
      runManifest: raw.runManifest,
    }),
    projections: sanitizeForPublication({}, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry: separateRegistry,
      runManifest: raw.runManifest,
    }),
  };
  assert.throws(
    () => publishAtomically({ paths, ...separatelySanitized }),
    /PUBLICATION_BOUNDARY_REQUIRED/u,
  );

  const immutableBoundary = sanitizeBundle(raw);
  assert.throws(
    () => {
      immutableBoundary.payloadArtifacts['REPORT.md'] = 'Unique post-sanitize private mutation';
    },
    TypeError,
  );

  const customArtifact = sanitizeBundle({
    ...raw,
    payloadArtifacts: { ...raw.payloadArtifacts, 'custom.json': {} },
  });
  assert.throws(
    () => publishAtomically({ paths, ...customArtifact, verifyPublication: testVerifier }),
    /ARTIFACT_SCHEMA_NOT_ALLOWED/u,
  );
}));

test('normalized raw hash and raw vault reference keys are forbidden in publications', () => withProject(({ paths }) => {
  for (const forbidden of [
    { rawHash: 'a'.repeat(64) },
    { raw_hash: 'a'.repeat(64) },
    { 'raw-hash': 'a'.repeat(64) },
    { rawRef: 'ev_1234567890abcdef' },
    { raw_ref: 'ev_1234567890abcdef' },
    { 'raw-reference': 'ev_1234567890abcdef' },
    { opaque_raw_vault_reference: 'ev_1234567890abcdef' },
    { opaqueRawVault: 'ev_1234567890abcdef' },
    { opaqueRef: 'raw_1234567890abcdef1234567890abcdef' },
  ]) {
    const input = sanitizeBundle({
      runManifest: {
        runId: 'raw-ref-run',
        publicationId: `raw-ref-${Object.keys(forbidden)[0]}`,
        week: '2026-W30',
        status: 'complete_partial',
      },
      payloadArtifacts: {
        'REPORT.md': '# Report\n',
        'metrics-and-findings.json': forbidden,
      },
      verifierAttestation: { result: 'pass' },
      projections: {},
    });
    assert.throws(() => publishAtomically({ paths, ...input }), /RAW_REFERENCE_FORBIDDEN/u);
  }
}));

test('pre-existing week symlink and non-canonical supplied paths cannot escape', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-audit-week-symlink-'));
  const external = mkdtempSync(join(tmpdir(), 'ghl-audit-week-external-'));
  const paths = auditPaths(projectRoot, 'L1');
  try {
    mkdirSync(paths.weekly, { recursive: true });
    symlinkSync(external, join(paths.weekly, '2026-W30'), 'dir');
    assert.throws(() => publishFixture(paths), /PUBLICATION_PATH_SYMLINK/u);
    assert.deepEqual(readdirSync(external), []);

    const forged = { ...paths, weekly: external };
    assert.throws(() => publishFixture(forged), /AUDIT_PATHS_INVALID/u);
    assert.deepEqual(readdirSync(external), []);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('projection failure after rename is recoverable and retry is idempotent', () => withProject(({ paths }) => {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(join(paths.root, 'CURRENT.md'));
  assert.throws(() => publishFixture(paths), /PROJECTION_UPDATE_FAILED/u);
  const publicationPath = join(paths.weekly, '2026-W30', 'pub-full');
  assert.equal(existsSync(join(publicationPath, 'run-manifest.json')), true);
  assert.equal(statSync(join(paths.weekly, '2026-W30')).mode & 0o222, 0);
  rmSync(join(paths.root, 'CURRENT.md'), { recursive: true });

  const recovered = publishFixture(paths);
  assert.equal(recovered.recovered, true);
  const index = JSON.parse(readFileSync(join(paths.root, 'index.json'), 'utf8'));
  assert.equal(index.publications.length, 1);
  assert.equal(index.latestFull.publicationId, 'pub-full');

  const conflict = sanitizeBundle({
    runManifest: {
      schemaVersion: '1.0.0',
      runId: 'run-2026-W30',
      publicationId: 'pub-full',
      week: '2026-W30',
      status: 'complete_full',
    },
    payloadArtifacts: {
      'REPORT.md': '# Conflicting report\n',
      'coverage.json': { status: 'complete' },
      'metrics-and-findings.json': { findings: [] },
    },
    verifierAttestation: { verifierVersion: '1.0.0', result: 'pass' },
    projections: {},
  });
  assert.throws(
    () => publishAtomically({ paths, ...conflict, verifyPublication: testVerifier }),
    /PUBLICATION_CONFLICT/u,
  );
}));

test('REPORT.md is mandatory before CURRENT.md can be created', () => withProject(({ paths }) => {
  const input = sanitizeBundle({
    runManifest: {
      runId: 'no-report-run',
      publicationId: 'no-report-publication',
      week: '2026-W30',
      status: 'complete_partial',
    },
    payloadArtifacts: {
      'metrics-and-findings.json': { findings: [] },
    },
    verifierAttestation: { result: 'pass' },
    projections: {},
  });
  assert.throws(
    () => publishAtomically({ paths, ...input, verifyPublication: testVerifier }),
    /REPORT_ARTIFACT_REQUIRED/u,
  );
  assert.equal(existsSync(join(paths.root, 'CURRENT.md')), false);
}));

test('publication rename and projections occur only after verifier pass', () => withProject(({ paths }) => {
  const input = sanitizeBundle({
    runManifest: {
      schemaVersion: '1.0.0',
      runId: 'verified-run',
      publicationId: 'verified-publication',
      week: '2026-W30',
      status: 'complete_full',
    },
    payloadArtifacts: {
      'REPORT.md': '# Verified report\n',
      'metrics-and-findings.json': { findings: [] },
    },
    verifierAttestation: {},
    projections: {
      'BACKLOG.md': '# Backlog\n',
    },
  }, DEFAULT_SOURCES, paths);
  assert.throws(
    () => publishAtomically({
      paths,
      ...input,
      verifyPublication() {
        throw Object.assign(new Error('VERIFIER_ATTESTATION_FAILED_TEST'), {
          code: 'VERIFIER_ATTESTATION_FAILED_TEST',
        });
      },
    }),
    /VERIFIER_ATTESTATION_FAILED_TEST/u,
  );
  assert.equal(existsSync(join(paths.weekly, '2026-W30', 'verified-publication')), false);
  assert.equal(existsSync(join(paths.root, 'CURRENT.md')), false);
  assert.equal(existsSync(join(paths.root, 'index.json')), false);
  assert.equal(existsSync(join(paths.root, 'memory', 'BACKLOG.md')), false);
}));

test('week container is read-only between publications while weekly root remains usable', () => withProject(({ paths }) => {
  publishFixture(paths);
  const weekDirectory = join(paths.weekly, '2026-W30');
  assert.equal(statSync(weekDirectory).mode & 0o222, 0);
  assert.notEqual(statSync(paths.weekly).mode & 0o200, 0);

  const second = publishFixture(paths, {
    runId: 'second-run',
    publicationId: 'second-publication',
    status: 'complete_partial',
  });
  assert.equal(existsSync(second.path), true);
  assert.equal(statSync(weekDirectory).mode & 0o222, 0);
  assert.notEqual(statSync(paths.weekly).mode & 0o200, 0);
}));

for (const replacementPhase of ['during-write', 'during-cleanup']) {
  test(`publication contains a week replacement ${replacementPhase}`, () => withProject(({ paths }) => {
    const weekDirectory = join(paths.weekly, '2026-W30');
    const displaced = join(paths.weekly, `2026-W30-displaced-${replacementPhase}`);
    const sentinel = join(weekDirectory, 'replacement-sentinel');
    const seamKey = Symbol.for('grom.audit.publication.fs-seam');
    let replaced = false;
    const replaceWeek = () => {
      if (replaced) return;
      replaced = true;
      chmodSync(paths.weekly, 0o755);
      renameSync(weekDirectory, displaced);
      mkdirSync(weekDirectory, { mode: 0o711 });
      writeFileSync(sentinel, 'replacement untouched', { mode: 0o600 });
    };
    globalThis[seamKey] = ({ phase }) => {
      if (replacementPhase === 'during-write' && phase === 'after-artifact-write') {
        replaceWeek();
      }
      if (replacementPhase === 'during-cleanup' && phase === 'after-artifact-write') {
        throw new Error('test-only write interruption');
      }
      if (replacementPhase === 'during-cleanup' && phase === 'before-staging-cleanup') {
        replaceWeek();
      }
    };
    try {
      assert.throws(
        () => publishFixture(paths),
        replacementPhase === 'during-write'
          ? /PUBLICATION_PATH_REPLACED/u
          : /PUBLICATION_FAILED/u,
      );
    } finally {
      delete globalThis[seamKey];
    }
    assert.equal(replaced, true);
    assert.equal(readFileSync(sentinel, 'utf8'), 'replacement untouched');
    assert.equal(statSync(weekDirectory).mode & 0o777, 0o711);
    assert.equal(statSync(displaced).mode & 0o222, 0);
    assert.deepEqual(
      readdirSync(paths.stateDir).filter((name) => name.startsWith('.publication-staging-')),
      [],
    );
    assert.deepEqual(readdirSync(displaced), []);
    assert.notEqual(statSync(paths.weekly).mode & 0o200, 0);
  }));
}

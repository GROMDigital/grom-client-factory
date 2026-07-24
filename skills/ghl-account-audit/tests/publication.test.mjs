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

function sanitizeBundle(raw, sources = []) {
  const registry = ingestPrivateSourceBundle({
    runManifest: raw.runManifest,
    sources,
  });
  return sanitizeForPublication(raw, {
    pseudonymKey: Buffer.alloc(32, 9),
    registry,
  });
}

function publishFixture(paths, overrides = {}, options = {}) {
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
  });
  return publishAtomically({ paths, ...publication, ...options });
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
      publishAtomically({ paths, ...unsafe });
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
  const publication = publishAtomically({ paths, ...input });
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
    () => ingestPrivateSourceBundle({
      runManifest,
      sources: [],
      complete: true,
    }),
    /PRIVATE_SOURCE_BUNDLE_INVALID/u,
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
  const incompleteRegistry = ingestPrivateSourceBundle({
    runManifest,
    sources: [{
      sourceId: 'contact-record-only',
      kind: 'pii',
      payload: { name: uniqueName },
    }],
  });
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
  const registry = ingestPrivateSourceBundle({
    runManifest,
    sources: [
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
    ],
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

  const mismatched = ingestPrivateSourceBundle({
    runManifest: { ...runManifest, runId: 'other-run' },
    sources: [],
  });
  assert.throws(
    () => sanitizeForPublication(fixture, {
      pseudonymKey: Buffer.alloc(32, 9),
      registry: mismatched,
    }),
    /PRIVATE_SOURCE_REGISTRY_MISMATCH/u,
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

  const separateRegistry = ingestPrivateSourceBundle({
    runManifest: raw.runManifest,
    sources: [],
  });
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
    () => publishAtomically({ paths, ...customArtifact }),
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
  assert.throws(() => publishAtomically({ paths, ...conflict }), /PUBLICATION_CONFLICT/u);
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
  assert.throws(() => publishAtomically({ paths, ...input }), /REPORT_ARTIFACT_REQUIRED/u);
  assert.equal(existsSync(join(paths.root, 'CURRENT.md')), false);
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

test('publication detects an inode replacement immediately before rename', () => withProject(({ paths }) => {
  const weekDirectory = join(paths.weekly, '2026-W30');
  const displaced = join(paths.weekly, '2026-W30-displaced');
  assert.throws(
    () => publishFixture(paths, {}, {
      hooks: {
        beforePublicationRename() {
          renameSync(weekDirectory, displaced);
          mkdirSync(weekDirectory, { mode: 0o755 });
        },
      },
    }),
    /PUBLICATION_PATH_REPLACED/u,
  );
  assert.equal(existsSync(join(weekDirectory, 'pub-full')), false);
  assert.equal(statSync(displaced).mode & 0o222, 0);
  assert.notEqual(statSync(paths.weekly).mode & 0o200, 0);
}));

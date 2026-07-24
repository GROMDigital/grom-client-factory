import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import {
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

function publishFixture(paths, overrides = {}) {
  const publication = sanitizeForPublication({
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
  }, {
    pseudonymKey: Buffer.alloc(32, 9),
    privateValues: [],
  });
  return publishAtomically({ paths, ...publication });
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
      const unsafe = sanitizeForPublication({
      runManifest: {
        runId: 'unsafe',
        publicationId: 'unsafe-publication',
        week: '2026-W30',
        status: 'complete_partial',
      },
      payloadArtifacts: { '../escape.json': {} },
      verifierAttestation: { result: 'pass' },
      projections: {},
      }, {
        pseudonymKey: Buffer.alloc(32, 9),
        privateValues: [],
      });
      publishAtomically({ paths, ...unsafe });
    },
    /INVALID_ARTIFACT_PATH/u,
  );
  publishFixture(paths);
  assert.equal(publishFixture(paths).recovered, true);
}));

test('backlog projections are atomically copied outside the immutable publication', () => withProject(({ paths }) => {
  const input = sanitizeForPublication({
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
  }, {
    pseudonymKey: Buffer.alloc(32, 9),
    privateValues: [],
  });
  const publication = publishAtomically({ paths, ...input });
  assert.ok(publication.path.endsWith(join('2026-W30', 'projection-publication')));
  for (const name of ['BACKLOG.md', 'backlog.json', 'current-system-flow.mmd']) {
    assert.equal(existsSync(join(paths.root, 'memory', name)), true, name);
  }
  assert.equal(publication.rootMembers.includes('BACKLOG.md'), false);
}));

test('unique private values only present in finding and proposal free text require a source registry', () => {
  const uniqueName = 'Unique Private Person Canary';
  const uniqueTranscript = 'Unique free-form transcript sentence that appears nowhere else.';
  const fixture = {
    finding: {
      summary: `${uniqueName} reported: ${uniqueTranscript}`,
    },
    proposal: {
      changeSet: {
        current: { copy: `Keep exact proposal structure for ${uniqueName}` },
        proposed: { copy: `Sanitized replacement for ${uniqueName}` },
      },
    },
  };
  assert.throws(
    () => sanitizeForPublication(fixture, {
      pseudonymKey: Buffer.alloc(32, 9),
    }),
    /PRIVATE_VALUE_REGISTRY_REQUIRED/u,
  );
  const sanitized = sanitizeForPublication(fixture, {
    pseudonymKey: Buffer.alloc(32, 9),
    privateValues: [
      { source: 'contact_record', kind: 'pii', value: uniqueName },
      { source: 'conversation_record', kind: 'private-content', value: uniqueTranscript },
    ],
  });
  const text = JSON.stringify(sanitized);
  assert.equal(text.includes(uniqueName), false);
  assert.equal(text.includes(uniqueTranscript), false);
  assert.match(
    sanitized.proposal.changeSet.current.copy,
    /^Keep exact proposal structure for psn_[a-f0-9]{32}$/u,
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

  const separatelySanitized = {
    runManifest: sanitizeForPublication(raw.runManifest, {
      pseudonymKey: Buffer.alloc(32, 9),
      privateValues: [],
    }),
    payloadArtifacts: sanitizeForPublication(raw.payloadArtifacts, {
      pseudonymKey: Buffer.alloc(32, 9),
      privateValues: [],
    }),
    verifierAttestation: sanitizeForPublication(raw.verifierAttestation, {
      pseudonymKey: Buffer.alloc(32, 9),
      privateValues: [],
    }),
    projections: sanitizeForPublication({}, {
      pseudonymKey: Buffer.alloc(32, 9),
      privateValues: [],
    }),
  };
  assert.throws(
    () => publishAtomically({ paths, ...separatelySanitized }),
    /PUBLICATION_BOUNDARY_REQUIRED/u,
  );

  const immutableBoundary = sanitizeForPublication(raw, {
    pseudonymKey: Buffer.alloc(32, 9),
    privateValues: [],
  });
  assert.throws(
    () => {
      immutableBoundary.payloadArtifacts['REPORT.md'] = 'Unique post-sanitize private mutation';
    },
    TypeError,
  );

  const customArtifact = sanitizeForPublication({
    ...raw,
    payloadArtifacts: { ...raw.payloadArtifacts, 'custom.json': {} },
  }, {
    pseudonymKey: Buffer.alloc(32, 9),
    privateValues: [],
  });
  assert.throws(
    () => publishAtomically({ paths, ...customArtifact }),
    /ARTIFACT_SCHEMA_NOT_ALLOWED/u,
  );
}));

test('raw hashes and raw vault references are forbidden in publications', () => withProject(({ paths }) => {
  for (const forbidden of [
    { rawHash: 'a'.repeat(64) },
    { opaqueRef: 'raw_1234567890abcdef1234567890abcdef' },
  ]) {
    const input = sanitizeForPublication({
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
    }, {
      pseudonymKey: Buffer.alloc(32, 9),
      privateValues: [],
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
    assert.throws(() => publishFixture(forged), /PUBLICATION_PATHS_INVALID/u);
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
  rmSync(join(paths.root, 'CURRENT.md'), { recursive: true });

  const recovered = publishFixture(paths);
  assert.equal(recovered.recovered, true);
  const index = JSON.parse(readFileSync(join(paths.root, 'index.json'), 'utf8'));
  assert.equal(index.publications.length, 1);
  assert.equal(index.latestFull.publicationId, 'pub-full');

  const conflict = sanitizeForPublication({
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
  }, {
    pseudonymKey: Buffer.alloc(32, 9),
    privateValues: [],
  });
  assert.throws(() => publishAtomically({ paths, ...conflict }), /PUBLICATION_CONFLICT/u);
}));

test('REPORT.md is mandatory before CURRENT.md can be created', () => withProject(({ paths }) => {
  const input = sanitizeForPublication({
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
  }, {
    pseudonymKey: Buffer.alloc(32, 9),
    privateValues: [],
  });
  assert.throws(() => publishAtomically({ paths, ...input }), /REPORT_ARTIFACT_REQUIRED/u);
  assert.equal(existsSync(join(paths.root, 'CURRENT.md')), false);
}));

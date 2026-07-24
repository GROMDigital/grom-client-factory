import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256 } from '../lib/canonical.mjs';
import { publishAtomically } from '../lib/artifacts.mjs';
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
  return publishAtomically({
    paths,
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
  });
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
    (error) => error.code === 'PUBLICATION_NOT_SANITIZED'
      && !String(error.stack).includes('ava.private@example.invalid')
      && !String(error.stack).includes('private-authorization-canary'),
  );
  assert.equal(existsSync(paths.root), false);
}));

test('publication rejects unsafe paths and cannot overwrite an immutable publication', () => withProject(({ paths }) => {
  assert.throws(
    () => publishAtomically({
      paths,
      runManifest: {
        runId: 'unsafe',
        publicationId: 'unsafe-publication',
        week: '2026-W30',
        status: 'complete_partial',
      },
      payloadArtifacts: { '../escape.json': {} },
      verifierAttestation: { result: 'pass' },
    }),
    /INVALID_ARTIFACT_PATH/u,
  );
  publishFixture(paths);
  assert.throws(() => publishFixture(paths), /PUBLICATION_EXISTS/u);
}));

test('backlog projections are atomically copied outside the immutable publication', () => withProject(({ paths }) => {
  const publication = publishAtomically({
    paths,
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
  assert.ok(publication.path.endsWith(join('2026-W30', 'projection-publication')));
  for (const name of ['BACKLOG.md', 'backlog.json', 'current-system-flow.mmd']) {
    assert.equal(existsSync(join(paths.root, 'memory', name)), true, name);
  }
  assert.equal(publication.rootMembers.includes('BACKLOG.md'), false);
}));

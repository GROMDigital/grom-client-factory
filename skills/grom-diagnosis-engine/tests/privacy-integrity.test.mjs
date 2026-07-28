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
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditPaths } from '../lib/paths.mjs';
import {
  openVault,
  resolveVaultKeys,
} from '../lib/vault.mjs';
import { openState } from '../lib/state.mjs';
import {
  ingestPrivateSourceBundle,
  sanitizeForPublication,
} from '../lib/artifacts.mjs';
import { sha256 } from '../lib/canonical.mjs';

const PRIVATE_CANARIES = Object.freeze([
  'Bearer private-authorization-canary',
  'eyJhbGciOiJIUzI1NiJ9.private.jwt-canary',
  'ava.private@example.invalid',
  '+61 412 345 678',
  'Ava Privatecanary',
  'RAW TRANSCRIPT PRIVATE CANARY',
  'RAW MESSAGE BODY PRIVATE CANARY',
  'https://example.invalid/magic-login?token=magic-private-canary',
  'key-reference-private-canary',
]);
const PRIVATE_CANARY_KINDS = Object.freeze([
  'credential',
  'credential',
  'pii',
  'pii',
  'pii',
  'private-content',
  'private-content',
  'credential',
  'key-reference',
]);
const PRIVATE_SOURCES = Object.freeze(PRIVATE_CANARIES.map((value, index) => Object.freeze({
  sourceId: `seeded-private-fixture-${index}`,
  kind: PRIVATE_CANARY_KINDS[index],
  payload: Object.freeze({ value }),
})));
const PRIVATE_SOURCE_INVENTORY = Object.freeze(PRIVATE_SOURCES
  .map((source) => Object.freeze({
    sourceId: source.sourceId,
    kind: source.kind,
    sourceHash: sha256({ schemaVersion: '1.0.0', source }),
  }))
  .sort((left, right) => (
    left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
  )));

const privateFixture = {
  headers: {
    authorization: PRIVATE_CANARIES[0],
    nested: [{ jwt: PRIVATE_CANARIES[1] }],
  },
  contact: {
    email: PRIVATE_CANARIES[2],
    phone: PRIVATE_CANARIES[3],
    name: PRIVATE_CANARIES[4],
  },
  conversation: {
    transcript: PRIVATE_CANARIES[5],
    messages: [{ body: PRIVATE_CANARIES[6] }],
  },
  nextStep: PRIVATE_CANARIES[7],
  provider: {
    keyReference: PRIVATE_CANARIES[8],
  },
  finding: {
    summary: `${PRIVATE_CANARIES[4]} missed a follow-up for ${PRIVATE_CANARIES[2]} (${PRIVATE_CANARIES[3]}).`,
  },
};
const PRIVACY_RUN_MANIFEST = Object.freeze({
  runId: 'privacy-fixture-run',
  publicationId: 'privacy-fixture-publication',
  week: '2026-W30',
  status: 'complete_partial',
});
const PRIVACY_FROZEN_INPUTS = Object.freeze({
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
  privateSourceInventory: PRIVATE_SOURCE_INVENTORY,
  privateSourceInventoryHash: sha256(PRIVATE_SOURCE_INVENTORY),
  target: {
    targetKind: 'location',
    operatingProfile: 'client',
    locationId: 'L1',
  },
});

function privateRegistry() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-audit-private-registry-'));
  const paths = auditPaths(projectRoot, 'L1');
  const state = openState({ projectRoot, locationId: 'L1' });
  const vault = openVault({
    paths,
    encryptionKey: Buffer.alloc(32, 91),
    pseudonymKey: Buffer.alloc(32, 92),
  });
  try {
    state.createRun({
      runId: PRIVACY_RUN_MANIFEST.runId,
      frozenInputs: PRIVACY_FROZEN_INPUTS,
      now: 1000,
    });
    const collector = vault.beginPrivateSourceCollection({
      state,
      runManifest: PRIVACY_RUN_MANIFEST,
    });
    for (const source of PRIVATE_SOURCES) collector.add(source);
    return ingestPrivateSourceBundle(collector.finalize());
  } finally {
    vault.close();
    state.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function withProject(callback) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-audit-vault-'));
  try {
    return callback({ projectRoot, paths: auditPaths(projectRoot, 'L1') });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('publishable artifacts contain no seeded private canaries', () => {
  const result = sanitizeForPublication(privateFixture, {
    pseudonymKey: Buffer.alloc(32, 7),
    registry: privateRegistry(),
    runManifest: PRIVACY_RUN_MANIFEST,
  });
  const text = JSON.stringify(result);
  for (const canary of PRIVATE_CANARIES) assert.equal(text.includes(canary), false, canary);
  assert.match(result.contact.email, /^psn_[a-f0-9]{32}$/u);
  assert.equal(result.contact.email, sanitizeForPublication(privateFixture, {
    pseudonymKey: Buffer.alloc(32, 7),
    registry: privateRegistry(),
    runManifest: PRIVACY_RUN_MANIFEST,
  }).contact.email);
  assert.match(result.finding.summary, /psn_[a-f0-9]{32}/u);
  assert.equal(result.finding.summary.includes(PRIVATE_CANARIES[4]), false);
});

test('protected key-file adapter accepts only an absolute current-user 0600 file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ghl-audit-keys-'));
  const keyPath = join(directory, 'vault-keys.json');
  const encryptionKey = Buffer.alloc(32, 11);
  const pseudonymKey = Buffer.alloc(32, 12);
  try {
    writeFileSync(keyPath, Buffer.concat([encryptionKey, pseudonymKey]), { mode: 0o600 });
    const resolved = resolveVaultKeys({
      keyReference: { type: 'protected-file', path: keyPath },
    });
    assert.deepEqual(resolved.encryptionKey, encryptionKey);
    assert.deepEqual(resolved.pseudonymKey, pseudonymKey);
    resolved.encryptionKey.fill(0);
    resolved.pseudonymKey.fill(0);

    chmodSync(keyPath, 0o640);
    assert.throws(
      () => resolveVaultKeys({
        keyReference: { type: 'protected-file', path: keyPath },
      }),
      (error) => error.code === 'VAULT_KEY_FILE_PERMISSIONS'
        && !error.message.includes(keyPath),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing keys and keychain failures expose only stable redacted codes', () => {
  const keyReference = 'key-reference-private-canary';
  const provider = {
    readKeychain(name) {
      assert.equal(name, keyReference);
      assert.equal(JSON.stringify(process.argv).includes(name), false);
      assert.equal(JSON.stringify(process.env).includes(name), false);
      throw new Error(`missing ${name}`);
    },
  };
  assert.throws(
    () => resolveVaultKeys({
      keyReference: { type: 'os-keychain', name: keyReference },
      keyProvider: provider,
    }),
    (error) => error.code === 'VAULT_KEYS_UNAVAILABLE'
      && error.message === 'VAULT_KEYS_UNAVAILABLE'
      && !String(error.stack).includes(keyReference),
  );
  assert.throws(
    () => resolveVaultKeys({
      keyReference: { type: 'protected-file', path: '/missing/key-file-private-canary' },
    }),
    (error) => error.code === 'VAULT_KEYS_UNAVAILABLE'
      && !String(error.stack).includes('key-file-private-canary'),
  );
});

test('OS-keychain adapter returns copied key buffers and clears provider material', () => {
  const providerMaterial = Buffer.concat([
    Buffer.alloc(32, 21),
    Buffer.alloc(32, 22),
  ]);
  const resolved = resolveVaultKeys({
    keyReference: { type: 'os-keychain', name: 'weekly-auditor' },
    keyProvider: {
      readKeychain: () => providerMaterial,
    },
  });
  assert.deepEqual(resolved.encryptionKey, Buffer.alloc(32, 21));
  assert.deepEqual(resolved.pseudonymKey, Buffer.alloc(32, 22));
  assert.ok(providerMaterial.every((byte) => byte === 0));
  resolved.encryptionKey.fill(0);
  resolved.pseudonymKey.fill(0);
});

test('key providers accept mutable binary material only and zero rejected buffers', () => {
  for (const material of [
    JSON.stringify({
      encryptionKey: Buffer.alloc(32, 1).toString('base64'),
      pseudonymKey: Buffer.alloc(32, 2).toString('base64'),
    }),
    {
      encryptionKey: Buffer.alloc(32, 1),
      pseudonymKey: Buffer.alloc(32, 2),
    },
  ]) {
    assert.throws(
      () => resolveVaultKeys({
        keyReference: { type: 'os-keychain', name: 'binary-only' },
        keyProvider: { readKeychain: () => material },
      }),
      /VAULT_KEY_MATERIAL_INVALID/u,
    );
    if (typeof material === 'object') {
      assert.ok(material.encryptionKey.every((byte) => byte === 0));
      assert.ok(material.pseudonymKey.every((byte) => byte === 0));
    }
  }
  const wrongLength = Buffer.alloc(63, 71);
  assert.throws(
    () => resolveVaultKeys({
      keyReference: { type: 'os-keychain', name: 'wrong-length' },
      keyProvider: { readKeychain: () => wrongLength },
    }),
    /VAULT_KEY_MATERIAL_INVALID/u,
  );
  assert.ok(wrongLength.every((byte) => byte === 0));
});

test('vault encrypts raw evidence under 0700 paths and zeroes handed-off keys', () => withProject(({ paths }) => {
  const encryptionKey = Buffer.alloc(32, 31);
  const pseudonymKey = Buffer.alloc(32, 32);
  const rawCanary = Buffer.from('RAW MESSAGE BODY PRIVATE CANARY', 'utf8');
  const vault = openVault({ paths, encryptionKey, pseudonymKey });
  assert.ok(encryptionKey.every((byte) => byte === 0));
  assert.ok(pseudonymKey.every((byte) => byte === 0));

  const sealed = vault.sealRaw({
    source: 'public_ghl',
    bytes: rawCanary,
    expiresAt: '2026-08-01T00:00:00.000Z',
  });
  assert.match(sealed.rawHash, /^[a-f0-9]{64}$/u);
  assert.match(sealed.opaqueRef, /^raw_[a-f0-9]{32}$/u);
  assert.equal(statSync(paths.privateRaw).mode & 0o777, 0o700);
  const recordPath = join(paths.privateRaw, `${sealed.opaqueRef}.json`);
  assert.equal(statSync(recordPath).mode & 0o777, 0o600);
  const recordText = readFileSync(recordPath, 'utf8');
  assert.equal(recordText.includes(rawCanary.toString('utf8')), false);
  const record = JSON.parse(recordText);
  assert.equal(record.expiresAt, '2026-08-01T00:00:00.000Z');
  assert.equal(record.deletionState, 'active');
  assert.equal(record.purgeResult, null);
  assert.equal(record.algorithm, 'aes-256-gcm');
  vault.close();
}));

test('vault rejects forged canonical paths before any filesystem mutation', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-audit-forged-vault-'));
  const external = mkdtempSync(join(tmpdir(), 'ghl-audit-forged-private-'));
  const paths = auditPaths(projectRoot, 'L1');
  const sentinel = join(external, 'sentinel');
  try {
    writeFileSync(sentinel, 'unchanged', { mode: 0o640 });
    const beforeMode = statSync(external).mode & 0o7777;
    const beforeSentinelMode = statSync(sentinel).mode & 0o7777;
    const encryptionKey = Buffer.alloc(32, 33);
    const pseudonymKey = Buffer.alloc(32, 34);
    assert.throws(
      () => openVault({
        paths: { ...paths, privateRaw: external },
        encryptionKey,
        pseudonymKey,
      }),
      /AUDIT_PATHS_INVALID/u,
    );
    assert.equal(statSync(external).mode & 0o7777, beforeMode);
    assert.equal(statSync(sentinel).mode & 0o7777, beforeSentinelMode);
    assert.deepEqual(readdirSync(external), ['sentinel']);
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('vault retains canonical paths when the caller mutates its supplied object', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ghl-audit-vault-path-retention-'));
  const external = mkdtempSync(join(tmpdir(), 'ghl-audit-vault-path-redirect-'));
  const mutablePaths = { ...auditPaths(projectRoot, 'L1') };
  try {
    const canonicalRaw = mutablePaths.privateRaw;
    const vault = openVault({
      paths: mutablePaths,
      encryptionKey: Buffer.alloc(32, 35),
      pseudonymKey: Buffer.alloc(32, 36),
    });
    mutablePaths.privateRaw = external;
    const sealed = vault.sealRaw({
      source: 'public_ghl',
      bytes: Buffer.from('canonical path retention', 'utf8'),
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(existsSync(join(canonicalRaw, `${sealed.opaqueRef}.json`)), true);
    assert.deepEqual(readdirSync(external), []);
    vault.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('doctor validates protected-file policy without reading or printing keys or references', () => {
  const home = mkdtempSync(join(tmpdir(), 'ghl-audit-doctor-'));
  const fakeBin = join(home, 'bin');
  const clientRoot = join(home, 'client-root');
  const tracking = join(home, 'tracking');
  const docs = join(home, 'docs');
  const plugin = join(home, 'plugin');
  const keyPath = join(home, 'key-reference-private-canary');
  const doctor = fileURLToPath(new URL('../../doctor/checks.sh', import.meta.url));
  try {
    for (const directory of [fakeBin, clientRoot, tracking, docs, plugin]) {
      mkdirSync(directory, { recursive: true });
    }
    for (const directory of [tracking, docs, plugin]) mkdirSync(join(directory, '.git'));
    writeFileSync(join(fakeBin, 'gh'), `#!/usr/bin/env bash
if [ "$1" = api ]; then printf 'authenticated\\n'; fi
exit 0
`, { mode: 0o700 });
    writeFileSync(join(fakeBin, 'git'), `#!/usr/bin/env bash
case "$*" in
  *rev-list*) printf '0\\n' ;;
esac
exit 0
`, { mode: 0o700 });
    writeFileSync(keyPath, 'RAW-KEY-BYTES-PRIVATE-CANARY', { mode: 0o600 });
    writeFileSync(join(home, '.grom-factory.json'), JSON.stringify({
      audit: {
        vault_key_reference: {
          type: 'protected-file',
          path: keyPath,
        },
      },
      client_root: clientRoot,
      plugin_path: plugin,
      deps: {
        'client-lp-tracking': { path: tracking, author_of: true },
        'ghl-workflow-api-docs': { path: docs, author_of: true },
        'ghl-plugin': { path: plugin, author_of: true },
      },
    }));
    const output = execFileSync('bash', [doctor], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });
    assert.match(output, /audit-vault-key\tPASS\tprotected vault key file reference and permissions are valid/u);
    assert.equal(output.includes(keyPath), false);
    assert.equal(output.includes('RAW-KEY-BYTES-PRIVATE-CANARY'), false);

    const doctorSource = readFileSync(doctor, 'utf8');
    assert.match(doctorSource, /SecItemCopyMatching/u);
    assert.match(doctorSource, /O_NOFOLLOW/u);
    assert.match(doctorSource, /fstatSync/u);
    assert.equal(doctorSource.includes('[ ! -f "$key_file" ]'), false);
    assert.equal(doctorSource.includes('[ -L "$key_file" ]'), false);
    assert.equal(doctorSource.includes('[ ! -O "$key_file" ]'), false);
    assert.equal(doctorSource.includes('dump-keychain'), false);
    assert.equal(doctorSource.includes('kSecReturnData'), false);

    const relocatedKeyPath = join(home, 'relocated-key-reference');
    renameSync(keyPath, relocatedKeyPath);
    symlinkSync(relocatedKeyPath, keyPath);
    const symlinked = spawnSync('bash', [doctor], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });
    assert.equal(symlinked.status, 1);
    assert.match(
      symlinked.stdout,
      /audit-vault-key\tFAIL\tprotected vault key file is missing, invalid, or insecure/u,
    );
    assert.equal(symlinked.stdout.includes(keyPath), false);
    assert.equal(symlinked.stdout.includes('RAW-KEY-BYTES-PRIVATE-CANARY'), false);

    const invalidConfig = JSON.parse(readFileSync(join(home, '.grom-factory.json'), 'utf8'));
    invalidConfig.audit.vault_key_reference.material = 'forbidden-material-canary';
    writeFileSync(join(home, '.grom-factory.json'), JSON.stringify(invalidConfig));
    const invalid = spawnSync('bash', [doctor], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });
    assert.equal(invalid.status, 1);
    assert.match(
      invalid.stdout,
      /audit-vault-key\tFAIL\t(?:vault key reference fields are invalid|raw vault key material is forbidden in config)/u,
    );
    assert.equal(invalid.stdout.includes('forbidden-material-canary'), false);
    assert.equal(invalid.stdout.includes(keyPath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('purge removes ciphertext and creates an immutable expiry event', () => withProject(({ paths }) => {
  const vault = openVault({
    paths,
    encryptionKey: Buffer.alloc(32, 41),
    pseudonymKey: Buffer.alloc(32, 42),
  });
  const sealed = vault.sealRaw({
    source: 'internal_ghl',
    bytes: Buffer.from('RAW TRANSCRIPT PRIVATE CANARY', 'utf8'),
    expiresAt: '2026-07-01T00:00:00.000Z',
  });
  const result = vault.purgeExpired({ now: '2026-07-24T00:00:00.000Z' });
  assert.equal(result.purged, 1);
  assert.equal(existsSync(join(paths.privateRaw, `${sealed.opaqueRef}.json`)), false);
  assert.equal(result.events.length, 1);
  const eventPath = join(paths.memoryEvents, `${result.events[0]}.json`);
  assert.equal(statSync(eventPath).mode & 0o222, 0);
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  assert.equal(event.type, 'raw_evidence_expired');
  assert.equal(event.opaqueRef, sealed.opaqueRef);
  assert.equal(event.deletionState, 'deleted');
  assert.equal(event.purgeResult, 'deleted');
  vault.close();
}));

test('AES-GCM authenticates every retention and identity metadata field before purge', () => {
  const mutations = {
    schemaVersion: '2.0.0',
    format: 'tampered-format',
    source: 'context',
    opaqueRef: 'raw_ffffffffffffffffffffffffffffffff',
    rawHash: 'f'.repeat(64),
    expiresAt: '2026-06-01T00:00:00.000Z',
  };
  for (const [field, replacement] of Object.entries(mutations)) {
    withProject(({ paths }) => {
      const vault = openVault({
        paths,
        encryptionKey: Buffer.alloc(32, 51),
        pseudonymKey: Buffer.alloc(32, 52),
      });
      const sealed = vault.sealRaw({
        source: 'internal_ghl',
        bytes: Buffer.from(`authenticated-${field}`, 'utf8'),
        expiresAt: '2026-07-01T00:00:00.000Z',
      });
      const recordPath = join(paths.privateRaw, `${sealed.opaqueRef}.json`);
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      record[field] = replacement;
      writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      assert.throws(
        () => vault.purgeExpired({ now: '2026-07-24T00:00:00.000Z' }),
        /RAW_EVIDENCE_AUTHENTICATION_FAILED/u,
        field,
      );
      assert.equal(existsSync(recordPath), true, field);
      vault.close();
    });
  }
});

test('purge event write failure leaves ciphertext retryable', () => withProject(({ paths }) => {
  const vault = openVault({
    paths,
    encryptionKey: Buffer.alloc(32, 61),
    pseudonymKey: Buffer.alloc(32, 62),
  });
  const sealed = vault.sealRaw({
    source: 'internal_ghl',
    bytes: Buffer.from('durable-purge-canary', 'utf8'),
    expiresAt: '2026-07-01T00:00:00.000Z',
  });
  const recordPath = join(paths.privateRaw, `${sealed.opaqueRef}.json`);
  chmodSync(paths.memoryEvents, 0o500);
  assert.throws(
    () => vault.purgeExpired({ now: '2026-07-24T00:00:00.000Z' }),
    /RAW_EXPIRY_EVENT_WRITE_FAILED/u,
  );
  assert.equal(existsSync(recordPath), true);
  chmodSync(paths.memoryEvents, 0o700);
  assert.equal(vault.purgeExpired({ now: '2026-07-24T00:00:00.000Z' }).purged, 1);
  assert.equal(existsSync(recordPath), false);
  vault.close();
}));

test('pending purge tombstone recovers crashes before and after ciphertext deletion', () => {
  for (const hookName of ['afterPending', 'afterUnlink']) {
    withProject(({ paths }) => {
      let interrupted = false;
      const vault = openVault({
        paths,
        encryptionKey: Buffer.alloc(32, 71),
        pseudonymKey: Buffer.alloc(32, 72),
      });
      const sealed = vault.sealRaw({
        source: 'internal_ghl',
        bytes: Buffer.from(`recover-${hookName}`, 'utf8'),
        expiresAt: '2026-07-01T00:00:00.000Z',
      });
      const recordPath = join(paths.privateRaw, `${sealed.opaqueRef}.json`);
      const seamKey = Symbol.for('grom.audit.vault.fs-seam');
      globalThis[seamKey] = (phase) => {
        if (phase === hookName && !interrupted) {
          interrupted = true;
          throw new Error('injected private failure detail');
        }
      };
      try {
        assert.throws(
          () => vault.purgeExpired({ now: '2026-07-24T00:00:00.000Z' }),
          (error) => error.code === 'PURGE_INTERRUPTED'
            && !String(error.stack).includes('injected private failure detail'),
        );
      } finally {
        delete globalThis[seamKey];
      }
      const eventFiles = readdirSync(paths.memoryEvents);
      assert.equal(eventFiles.length, 1);
      const pending = JSON.parse(readFileSync(join(paths.memoryEvents, eventFiles[0]), 'utf8'));
      assert.equal(pending.type, 'raw_evidence_expired');
      assert.equal(pending.deletionState, 'pending');
      assert.equal(existsSync(recordPath), hookName === 'afterPending');
      vault.close();

      const recovery = openVault({
        paths,
        encryptionKey: Buffer.alloc(32, 71),
        pseudonymKey: Buffer.alloc(32, 72),
      });
      const result = recovery.purgeExpired({ now: '2026-07-24T00:00:00.000Z' });
      assert.equal(existsSync(recordPath), false);
      assert.equal(result.events.length, 1);
      const completed = JSON.parse(readFileSync(
        join(paths.memoryEvents, `${result.events[0]}.json`),
        'utf8',
      ));
      assert.equal(completed.deletionState, 'deleted');
      assert.equal(completed.purgeResult, 'deleted');
      recovery.close();
    });
  }
});

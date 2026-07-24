import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { canonicalJson } from './canonical.mjs';
import { ensureAuditPaths } from './paths.mjs';

const KEY_BYTES = 32;
const KEY_FILE_BYTES = KEY_BYTES * 2;
const SAFE_SOURCE = /^[a-z][a-z0-9_:-]{0,63}$/u;

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function copyKey(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw codedError('VAULT_KEY_MATERIAL_INVALID', TypeError);
  }
  const copied = Buffer.from(value);
  if (copied.length !== KEY_BYTES) {
    copied.fill(0);
    throw codedError('VAULT_KEY_MATERIAL_INVALID', TypeError);
  }
  return copied;
}

function decodeKey(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return copyKey(value);
  if (typeof value !== 'string') throw codedError('VAULT_KEY_MATERIAL_INVALID', TypeError);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== KEY_BYTES || decoded.toString('base64') !== value) {
    decoded.fill(0);
    throw codedError('VAULT_KEY_MATERIAL_INVALID', TypeError);
  }
  return decoded;
}

function splitKeyMaterial(material) {
  if (Buffer.isBuffer(material) || material instanceof Uint8Array) {
    if (material.byteLength === KEY_FILE_BYTES) {
      return {
        encryptionKey: Buffer.from(material.subarray(0, KEY_BYTES)),
        pseudonymKey: Buffer.from(material.subarray(KEY_BYTES)),
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(material).toString('utf8'));
    } catch {
      throw codedError('VAULT_KEY_MATERIAL_INVALID', TypeError);
    }
    return splitKeyMaterial(parsed);
  }
  if (typeof material === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(material);
    } catch {
      throw codedError('VAULT_KEY_MATERIAL_INVALID', TypeError);
    }
    return splitKeyMaterial(parsed);
  }
  if (!material || typeof material !== 'object' || Array.isArray(material)) {
    throw codedError('VAULT_KEY_MATERIAL_INVALID', TypeError);
  }
  let encryptionKey;
  let pseudonymKey;
  try {
    encryptionKey = decodeKey(material.encryptionKey);
    pseudonymKey = decodeKey(material.pseudonymKey);
    return { encryptionKey, pseudonymKey };
  } catch (error) {
    encryptionKey?.fill(0);
    pseudonymKey?.fill(0);
    throw error;
  }
}

function clearProviderMaterial(material) {
  if (Buffer.isBuffer(material) || material instanceof Uint8Array) {
    material.fill(0);
    return;
  }
  if (material && typeof material === 'object') {
    for (const value of Object.values(material)) {
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) value.fill(0);
    }
  }
}

function normalizeReference(keyReference) {
  if (!keyReference || typeof keyReference !== 'object' || Array.isArray(keyReference)) {
    throw codedError('VAULT_KEY_REFERENCE_INVALID', TypeError);
  }
  const type = keyReference.type ?? keyReference.provider;
  if (type === 'protected-file' || type === 'file') {
    const path = keyReference.path;
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw codedError('VAULT_KEY_REFERENCE_INVALID', TypeError);
    }
    return { type: 'protected-file', path };
  }
  if (type === 'os-keychain' || type === 'keychain') {
    const name = keyReference.name ?? keyReference.reference;
    if (
      typeof name !== 'string'
      || name.trim().length === 0
      || name.includes('\0')
      || name.includes('\n')
    ) throw codedError('VAULT_KEY_REFERENCE_INVALID', TypeError);
    return { type: 'os-keychain', name };
  }
  throw codedError('VAULT_KEY_REFERENCE_INVALID', TypeError);
}

function protectedFileMaterial(path) {
  let descriptor;
  let contents;
  try {
    if (lstatSync(path).isSymbolicLink()) throw codedError('VAULT_KEY_FILE_INVALID');
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw codedError('VAULT_KEY_FILE_INVALID');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw codedError('VAULT_KEY_FILE_OWNERSHIP');
    }
    if ((metadata.mode & 0o7777) !== 0o600) throw codedError('VAULT_KEY_FILE_PERMISSIONS');
    contents = readFileSync(descriptor);
    return Buffer.from(contents);
  } catch (error) {
    if (
      error?.code === 'VAULT_KEY_FILE_INVALID'
      || error?.code === 'VAULT_KEY_FILE_OWNERSHIP'
      || error?.code === 'VAULT_KEY_FILE_PERMISSIONS'
    ) throw error;
    throw codedError('VAULT_KEYS_UNAVAILABLE');
  } finally {
    if (contents) contents.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function keychainMaterial(name, keyProvider) {
  if (!keyProvider) throw codedError('VAULT_KEYS_UNAVAILABLE');
  try {
    if (typeof keyProvider === 'function') return keyProvider({ type: 'os-keychain', name });
    if (typeof keyProvider.readKeychain === 'function') return keyProvider.readKeychain(name);
    if (typeof keyProvider.resolve === 'function') return keyProvider.resolve({ type: 'os-keychain', name });
    if (typeof keyProvider.get === 'function') return keyProvider.get({ type: 'os-keychain', name });
    throw codedError('VAULT_KEYS_UNAVAILABLE');
  } catch {
    throw codedError('VAULT_KEYS_UNAVAILABLE');
  }
}

export function resolveVaultKeys({ keyReference, keyProvider } = {}) {
  const reference = normalizeReference(keyReference);
  let material;
  let keys;
  try {
    material = reference.type === 'protected-file'
      ? protectedFileMaterial(reference.path)
      : keychainMaterial(reference.name, keyProvider);
    keys = splitKeyMaterial(material);
    return keys;
  } catch (error) {
    if (keys) {
      keys.encryptionKey.fill(0);
      keys.pseudonymKey.fill(0);
    }
    if (error?.code?.startsWith('VAULT_KEY_FILE_')) throw error;
    if (error?.code === 'VAULT_KEY_REFERENCE_INVALID') throw error;
    throw codedError(error?.code === 'VAULT_KEY_MATERIAL_INVALID'
      ? 'VAULT_KEY_MATERIAL_INVALID'
      : 'VAULT_KEYS_UNAVAILABLE');
  } finally {
    clearProviderMaterial(material);
  }
}

function validateExpiry(expiresAt) {
  if (
    typeof expiresAt !== 'string'
    || !Number.isFinite(Date.parse(expiresAt))
    || new Date(expiresAt).toISOString() !== expiresAt
  ) throw codedError('RAW_EVIDENCE_EXPIRY_INVALID', TypeError);
}

function immutableEventPath(paths, eventId) {
  return join(paths.memoryEvents, `${eventId}.json`);
}

export function openVault({ paths, encryptionKey, pseudonymKey } = {}) {
  let cipherKey;
  let subjectKey;
  try {
    cipherKey = copyKey(encryptionKey);
    subjectKey = copyKey(pseudonymKey);
  } catch (error) {
    cipherKey?.fill(0);
    subjectKey?.fill(0);
    throw error;
  } finally {
    if (Buffer.isBuffer(encryptionKey) || encryptionKey instanceof Uint8Array) encryptionKey.fill(0);
    if (Buffer.isBuffer(pseudonymKey) || pseudonymKey instanceof Uint8Array) pseudonymKey.fill(0);
  }

  try {
    ensureAuditPaths(paths);
    chmodSync(join(paths.privateRaw, '..'), 0o700);
    for (const directory of [paths.privateRaw, paths.privateLogs, paths.privateCheckpoints]) {
      chmodSync(directory, 0o700);
    }
    chmodSync(paths.stateDir, 0o700);
  } catch (error) {
    cipherKey.fill(0);
    subjectKey.fill(0);
    throw error;
  }

  let closed = false;
  const assertOpen = () => {
    if (closed) throw codedError('VAULT_CLOSED');
  };

  return Object.freeze({
    sealRaw({ source, bytes, expiresAt } = {}) {
      assertOpen();
      if (typeof source !== 'string' || !SAFE_SOURCE.test(source)) {
        throw codedError('RAW_EVIDENCE_SOURCE_INVALID', TypeError);
      }
      if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
        throw codedError('RAW_EVIDENCE_BYTES_INVALID', TypeError);
      }
      validateExpiry(expiresAt);

      const plaintext = Buffer.from(bytes);
      const nonce = randomBytes(12);
      const rawHash = createHash('sha256').update(plaintext).digest('hex');
      const opaqueRef = `raw_${createHmac('sha256', subjectKey)
        .update(source)
        .update('\0')
        .update(rawHash)
        .update(nonce)
        .digest('hex')
        .slice(0, 32)}`;
      const cipher = createCipheriv('aes-256-gcm', cipherKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const record = {
        schemaVersion: '1.0.0',
        opaqueRef,
        rawHash,
        source,
        algorithm: 'aes-256-gcm',
        nonce: nonce.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        expiresAt,
        deletionState: 'active',
        purgeResult: null,
      };
      plaintext.fill(0);
      writeFileSync(
        join(paths.privateRaw, `${opaqueRef}.json`),
        `${canonicalJson(record)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      return Object.freeze({ rawHash, opaqueRef });
    },

    purgeExpired({ now = new Date().toISOString() } = {}) {
      assertOpen();
      validateExpiry(now);
      let purged = 0;
      const events = [];
      for (const name of readdirSync(paths.privateRaw).sort()) {
        if (!/^raw_[a-f0-9]{32}\.json$/u.test(name)) continue;
        const recordPath = join(paths.privateRaw, name);
        let record;
        try {
          record = JSON.parse(readFileSync(recordPath, 'utf8'));
        } catch {
          throw codedError('RAW_EVIDENCE_RECORD_INVALID');
        }
        validateExpiry(record.expiresAt);
        if (Date.parse(record.expiresAt) > Date.parse(now)) continue;
        unlinkSync(recordPath);
        const eventId = `evt_${createHmac('sha256', subjectKey)
          .update(record.opaqueRef)
          .update('\0')
          .update(now)
          .digest('hex')
          .slice(0, 32)}`;
        const event = {
          schemaVersion: '1.0.0',
          eventId,
          type: 'raw_evidence_expired',
          opaqueRef: record.opaqueRef,
          rawHash: record.rawHash,
          expiresAt: record.expiresAt,
          expiredAt: now,
          deletionState: 'deleted',
          purgeResult: 'deleted',
        };
        const eventPath = immutableEventPath(paths, eventId);
        writeFileSync(eventPath, `${canonicalJson(event)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o400,
        });
        chmodSync(eventPath, 0o400);
        purged += 1;
        events.push(eventId);
      }
      return Object.freeze({ purged, events: Object.freeze(events) });
    },

    close() {
      if (!closed) {
        cipherKey.fill(0);
        subjectKey.fill(0);
        closed = true;
      }
    },
  });
}

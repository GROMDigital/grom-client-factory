import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { canonicalJson, sha256 } from './canonical.mjs';
import { ensureAuditPaths, validateAuditPaths } from './paths.mjs';
import { derivePrivateSourceEntries } from './private-source-authority.mjs';
import { AuditState } from './state.mjs';

const KEY_BYTES = 32;
const KEY_FILE_BYTES = KEY_BYTES * 2;
const RAW_FORMAT = 'grom-raw-evidence';
const RAW_SCHEMA_VERSION = '1.0.0';
const RAW_ALGORITHM = 'aes-256-gcm';
const SAFE_SOURCE = /^[a-z][a-z0-9_:-]{0,63}$/u;
const RAW_FILE = /^raw_[a-f0-9]{32}\.json$/u;
const EVENT_FILE = /^evt_[a-f0-9]{32}\.json$/u;
const AUTHORITATIVE_SOURCE_BUNDLES = new WeakMap();
const VAULT_TEST_SEAM = Symbol.for('grom.audit.vault.fs-seam');

function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}

function issueAuthoritativePrivateSourceBundle(metadata) {
  const token = Object.freeze(Object.create(null));
  AUTHORITATIVE_SOURCE_BUNDLES.set(token, Object.freeze({
    ...metadata,
    entries: Object.freeze([...metadata.entries]),
  }));
  return token;
}

export function inspectAuthoritativePrivateSourceBundle(token) {
  return AUTHORITATIVE_SOURCE_BUNDLES.get(token);
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

function splitMutableKeyMaterial(material) {
  if (!Buffer.isBuffer(material) && !(material instanceof Uint8Array)) {
    throw codedError('VAULT_KEY_MATERIAL_INVALID', TypeError);
  }
  if (material.byteLength !== KEY_FILE_BYTES) {
    throw codedError('VAULT_KEY_MATERIAL_INVALID', TypeError);
  }
  return {
    encryptionKey: Buffer.from(material.subarray(0, KEY_BYTES)),
    pseudonymKey: Buffer.from(material.subarray(KEY_BYTES)),
  };
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
  if (
    !keyReference
    || typeof keyReference !== 'object'
    || Array.isArray(keyReference)
    || Object.getPrototypeOf(keyReference) !== Object.prototype
  ) {
    throw codedError('VAULT_KEY_REFERENCE_INVALID', TypeError);
  }
  const type = keyReference.type ?? keyReference.provider;
  if (Object.hasOwn(keyReference, 'type') === Object.hasOwn(keyReference, 'provider')) {
    throw codedError('VAULT_KEY_REFERENCE_INVALID', TypeError);
  }
  if (type === 'protected-file' || type === 'file') {
    const path = keyReference.path;
    if (
      typeof path !== 'string'
      || !isAbsolute(path)
      || Object.keys(keyReference).some((key) => !['type', 'provider', 'path'].includes(key))
    ) {
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
      || Object.hasOwn(keyReference, 'name') === Object.hasOwn(keyReference, 'reference')
      || Object.keys(keyReference).some((key) => !['type', 'provider', 'name', 'reference'].includes(key))
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
    contents?.fill(0);
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
    keys = splitMutableKeyMaterial(material);
    return keys;
  } catch (error) {
    keys?.encryptionKey.fill(0);
    keys?.pseudonymKey.fill(0);
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

function rawHeader({ opaqueRef, rawHash, source, expiresAt }) {
  return {
    schemaVersion: RAW_SCHEMA_VERSION,
    format: RAW_FORMAT,
    algorithm: RAW_ALGORITHM,
    opaqueRef,
    rawHash,
    source,
    expiresAt,
  };
}

function aadBytes(header) {
  return Buffer.from(canonicalJson(header), 'utf8');
}

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string') throw codedError('RAW_EVIDENCE_AUTHENTICATION_FAILED');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedLength || decoded.toString('base64') !== value) {
    decoded.fill(0);
    throw codedError('RAW_EVIDENCE_AUTHENTICATION_FAILED');
  }
  return decoded;
}

function verifyRecord(record, expectedOpaqueRef, cipherKey) {
  let nonce;
  let authTag;
  let ciphertext;
  let plaintext;
  try {
    if (
      !record
      || typeof record !== 'object'
      || Array.isArray(record)
      || record.schemaVersion !== RAW_SCHEMA_VERSION
      || record.format !== RAW_FORMAT
      || record.algorithm !== RAW_ALGORITHM
      || record.opaqueRef !== expectedOpaqueRef
      || !/^raw_[a-f0-9]{32}$/u.test(record.opaqueRef)
      || !/^[a-f0-9]{64}$/u.test(record.rawHash)
      || !SAFE_SOURCE.test(record.source)
      || record.deletionState !== 'active'
      || record.purgeResult !== null
    ) throw codedError('RAW_EVIDENCE_AUTHENTICATION_FAILED');
    const header = rawHeader(record);
    nonce = decodeBase64(record.nonce, 12);
    authTag = decodeBase64(record.authTag, 16);
    if (typeof record.ciphertext !== 'string') throw codedError('RAW_EVIDENCE_AUTHENTICATION_FAILED');
    ciphertext = Buffer.from(record.ciphertext, 'base64');
    if (ciphertext.toString('base64') !== record.ciphertext) {
      throw codedError('RAW_EVIDENCE_AUTHENTICATION_FAILED');
    }
    const decipher = createDecipheriv(RAW_ALGORITHM, cipherKey, nonce);
    decipher.setAAD(aadBytes(header));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const computedHash = createHash('sha256').update(plaintext).digest('hex');
    if (computedHash !== record.rawHash) throw codedError('RAW_EVIDENCE_AUTHENTICATION_FAILED');
    validateExpiry(record.expiresAt);
    return header;
  } catch {
    throw codedError('RAW_EVIDENCE_AUTHENTICATION_FAILED');
  } finally {
    nonce?.fill(0);
    authTag?.fill(0);
    ciphertext?.fill(0);
    plaintext?.fill(0);
  }
}

function eventIds(header, subjectKey, expiredAt) {
  const operationId = `purge_${createHmac('sha256', subjectKey)
    .update(canonicalJson(header))
    .digest('hex')
    .slice(0, 32)}`;
  const eventId = (phase) => `evt_${createHmac('sha256', subjectKey)
    .update(operationId)
    .update('\0')
    .update(phase)
    .update('\0')
    .update(expiredAt)
    .digest('hex')
    .slice(0, 32)}`;
  return {
    operationId,
    pendingEventId: eventId('pending'),
    completedEventId: eventId('completed'),
  };
}

function eventPath(paths, eventId) {
  return join(paths.memoryEvents, `${eventId}.json`);
}

function readJson(path, failureCode) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw codedError(failureCode);
  }
}

function syncImmutableEvent(path, directory) {
  let descriptor;
  let directoryDescriptor;
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o222) !== 0) {
      throw new Error();
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    fsyncSync(descriptor);
    directoryDescriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(directoryDescriptor);
  } catch {
    throw codedError('RAW_EXPIRY_EVENT_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
}

function writeImmutableEvent(paths, event) {
  const path = eventPath(paths, event.eventId);
  if (existsSync(path)) {
    const existing = readJson(path, 'RAW_EXPIRY_EVENT_INVALID');
    if (canonicalJson(existing) !== canonicalJson(event)) {
      throw codedError('RAW_EXPIRY_EVENT_CONFLICT');
    }
    syncImmutableEvent(path, paths.memoryEvents);
    return false;
  }
  const temporary = join(paths.memoryEvents, `.${event.eventId}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  let directoryDescriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400);
    writeFileSync(descriptor, `${canonicalJson(event)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o400);
    linkSync(temporary, path);
    unlinkSync(temporary);
    directoryDescriptor = openSync(paths.memoryEvents, constants.O_RDONLY);
    fsyncSync(directoryDescriptor);
    return true;
  } catch {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch {
        // The stable error below deliberately omits all filesystem details.
      }
    }
    throw codedError('RAW_EXPIRY_EVENT_WRITE_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
}

function readRawRecord(path) {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error();
    return readJson(path, 'RAW_EVIDENCE_RECORD_INVALID');
  } catch (error) {
    if (error?.code === 'RAW_EVIDENCE_RECORD_INVALID') throw error;
    throw codedError('RAW_EVIDENCE_RECORD_INVALID');
  }
}

function expiryEvent(header, now, subjectKey, phase) {
  const ids = eventIds(header, subjectKey, now);
  return {
    schemaVersion: RAW_SCHEMA_VERSION,
    format: RAW_FORMAT,
    algorithm: RAW_ALGORITHM,
    eventId: phase === 'pending' ? ids.pendingEventId : ids.completedEventId,
    type: 'raw_evidence_expired',
    operationId: ids.operationId,
    phase,
    pendingEventId: ids.pendingEventId,
    opaqueRef: header.opaqueRef,
    rawHash: header.rawHash,
    source: header.source,
    expiresAt: header.expiresAt,
    expiredAt: now,
    deletionState: phase === 'pending' ? 'pending' : 'deleted',
    purgeResult: phase === 'pending' ? 'pending' : 'deleted',
  };
}

function validatePendingEvent(event, subjectKey) {
  try {
    const header = rawHeader(event);
    const ids = eventIds(header, subjectKey, event.expiredAt);
    if (
      event.schemaVersion !== RAW_SCHEMA_VERSION
      || event.format !== RAW_FORMAT
      || event.algorithm !== RAW_ALGORITHM
      || event.type !== 'raw_evidence_expired'
      || event.phase !== 'pending'
      || event.operationId !== ids.operationId
      || event.eventId !== ids.pendingEventId
      || event.pendingEventId !== ids.pendingEventId
      || event.deletionState !== 'pending'
      || event.purgeResult !== 'pending'
    ) throw new Error();
    validateExpiry(event.expiresAt);
    validateExpiry(event.expiredAt);
    return header;
  } catch {
    throw codedError('RAW_EXPIRY_EVENT_INVALID');
  }
}

function invokeVaultTestSeam(name) {
  if (!process.env.NODE_TEST_CONTEXT) return;
  const seam = globalThis[VAULT_TEST_SEAM];
  if (typeof seam !== 'function') return;
  try {
    seam(name);
  } catch {
    throw codedError('PURGE_INTERRUPTED');
  }
}

function unlinkCiphertext(path) {
  try {
    unlinkSync(path);
  } catch {
    throw codedError('RAW_EVIDENCE_DELETE_FAILED');
  }
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

  let canonicalPaths;
  try {
    canonicalPaths = validateAuditPaths(paths);
    ensureAuditPaths(canonicalPaths);
    chmodSync(join(canonicalPaths.privateRaw, '..'), 0o700);
    for (const directory of [
      canonicalPaths.privateRaw,
      canonicalPaths.privateLogs,
      canonicalPaths.privateCheckpoints,
      canonicalPaths.stateDir,
    ]) chmodSync(directory, 0o700);
  } catch (error) {
    cipherKey.fill(0);
    subjectKey.fill(0);
    throw error;
  }

  let closed = false;
  const assertOpen = () => {
    if (closed) throw codedError('VAULT_CLOSED');
  };

  function completePending(event, now) {
    const header = validatePendingEvent(event, subjectKey);
    const recordPath = join(canonicalPaths.privateRaw, `${header.opaqueRef}.json`);
    let removed = false;
    if (existsSync(recordPath)) {
      const record = readRawRecord(recordPath);
      const verified = verifyRecord(record, header.opaqueRef, cipherKey);
      if (canonicalJson(verified) !== canonicalJson(header)) {
        throw codedError('RAW_EXPIRY_EVENT_CONFLICT');
      }
      unlinkCiphertext(recordPath);
      removed = true;
      invokeVaultTestSeam('afterUnlink');
    }
    const completed = expiryEvent(header, event.expiredAt ?? now, subjectKey, 'completed');
    writeImmutableEvent(canonicalPaths, completed);
    return { removed, eventId: completed.eventId };
  }

  return Object.freeze({
    beginPrivateSourceCollection({ state, runManifest } = {}) {
      assertOpen();
      if (
        !(state instanceof AuditState)
        || !runManifest
        || typeof runManifest !== 'object'
        || Array.isArray(runManifest)
        || Object.getPrototypeOf(runManifest) !== Object.prototype
        || typeof runManifest.runId !== 'string'
        || runManifest.runId.length === 0
        || state.paths.stateDb !== canonicalPaths.stateDb
      ) throw codedError('PRIVATE_SOURCE_AUTHORITY_INVALID', TypeError);
      const manifestHash = sha256(runManifest);
      const collected = new Map();
      let finalized = false;
      return Object.freeze({
        add(source) {
          assertOpen();
          if (finalized) throw codedError('PRIVATE_SOURCE_COLLECTION_FINALIZED');
          const entries = derivePrivateSourceEntries([source]);
          if (collected.has(source.sourceId)) {
            throw codedError('PRIVATE_SOURCE_INVENTORY_INVALID', TypeError);
          }
          const snapshot = JSON.parse(canonicalJson(source));
          collected.set(source.sourceId, Object.freeze({
            source: Object.freeze(snapshot),
            entries,
          }));
          return Object.freeze({ sourceId: source.sourceId, kind: source.kind });
        },
        finalize(options) {
          assertOpen();
          if (finalized) throw codedError('PRIVATE_SOURCE_COLLECTION_FINALIZED');
          if (options !== undefined) {
            throw codedError('PRIVATE_SOURCE_AUTHORITY_INVALID', TypeError);
          }
          if (collected.size === 0) {
            throw codedError('PRIVATE_SOURCE_INVENTORY_REQUIRED', TypeError);
          }
          const collectedRecords = [...collected.values()]
            .sort((left, right) => (
              left.source.sourceId < right.source.sourceId
                ? -1
                : left.source.sourceId > right.source.sourceId ? 1 : 0
            ));
          const sources = collectedRecords.map(({ source }) => source);
          const inventory = sources.map(({ sourceId, kind }) => ({ sourceId, kind }));
          const entries = Object.freeze(collectedRecords.flatMap((record) => record.entries));
          const sourceInventoryHash = sha256(inventory);
          const sourceBundleHash = sha256({ schemaVersion: '1.0.0', sources });
          const inventoryMetadata = {
            schemaVersion: '1.0.0',
            manifestHash,
            sourceInventoryHash,
            sourceBundleHash,
            sourceRecordCount: sources.length,
            sourceValueCount: entries.length,
            sourceIds: inventory.map(({ sourceId }) => sourceId),
          };
          const inventorySignature = createHmac('sha256', subjectKey)
            .update(canonicalJson(inventoryMetadata))
            .digest('hex');
          const checkpointPayload = {
            ...inventoryMetadata,
            inventorySignature,
          };
          state.saveCheckpoint({
            runId: runManifest.runId,
            phase: 'private-source-inventory',
            inputHash: sha256({ manifestHash, sourceInventoryHash }),
            outputHash: sourceBundleHash,
            payload: checkpointPayload,
          });
          const durable = state.getCheckpoint({
            runId: runManifest.runId,
            phase: 'private-source-inventory',
          });
          if (
            !durable
            || durable.outputHash !== sourceBundleHash
            || canonicalJson(durable.payload) !== canonicalJson(checkpointPayload)
          ) throw codedError('PRIVATE_SOURCE_INVENTORY_NOT_DURABLE');
          const authoritativeBundle = issueAuthoritativePrivateSourceBundle({
            ...inventoryMetadata,
            inventorySignature,
            entries,
          });
          finalized = true;
          return authoritativeBundle;
        },
      });
    },

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
      const header = rawHeader({ opaqueRef, rawHash, source, expiresAt });
      const cipher = createCipheriv(RAW_ALGORITHM, cipherKey, nonce);
      cipher.setAAD(aadBytes(header));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const record = {
        ...header,
        nonce: nonce.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        deletionState: 'active',
        purgeResult: null,
      };
      plaintext.fill(0);
      ciphertext.fill(0);
      try {
        writeFileSync(
          join(canonicalPaths.privateRaw, `${opaqueRef}.json`),
          `${canonicalJson(record)}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
      } catch {
        throw codedError('RAW_EVIDENCE_WRITE_FAILED');
      }
      return Object.freeze({ rawHash, opaqueRef });
    },

    purgeExpired({ now = new Date().toISOString() } = {}) {
      assertOpen();
      validateExpiry(now);
      let purged = 0;
      const events = [];

      for (const name of readdirSync(canonicalPaths.memoryEvents).sort()) {
        if (!EVENT_FILE.test(name)) continue;
        const event = readJson(join(canonicalPaths.memoryEvents, name), 'RAW_EXPIRY_EVENT_INVALID');
        if (event.phase !== 'pending') continue;
        const header = validatePendingEvent(event, subjectKey);
        const completedId = eventIds(header, subjectKey, event.expiredAt).completedEventId;
        if (existsSync(eventPath(canonicalPaths, completedId))) {
          const completed = readJson(eventPath(canonicalPaths, completedId), 'RAW_EXPIRY_EVENT_INVALID');
          const expected = expiryEvent(header, event.expiredAt, subjectKey, 'completed');
          if (canonicalJson(completed) !== canonicalJson(expected)) {
            throw codedError('RAW_EXPIRY_EVENT_INVALID');
          }
          continue;
        }
        const recovered = completePending(event, now);
        if (recovered.removed) purged += 1;
        events.push(recovered.eventId);
      }

      for (const name of readdirSync(canonicalPaths.privateRaw).sort()) {
        if (!RAW_FILE.test(name)) continue;
        const recordPath = join(canonicalPaths.privateRaw, name);
        const record = readRawRecord(recordPath);
        const expectedOpaqueRef = name.slice(0, -'.json'.length);
        const header = verifyRecord(record, expectedOpaqueRef, cipherKey);
        if (Date.parse(header.expiresAt) > Date.parse(now)) continue;

        const pending = expiryEvent(header, now, subjectKey, 'pending');
        writeImmutableEvent(canonicalPaths, pending);
        invokeVaultTestSeam('afterPending');
        unlinkCiphertext(recordPath);
        invokeVaultTestSeam('afterUnlink');
        const completed = expiryEvent(header, now, subjectKey, 'completed');
        writeImmutableEvent(canonicalPaths, completed);
        purged += 1;
        events.push(completed.eventId);
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

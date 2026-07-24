import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { codedError } from './collection.mjs';
import {
  assertTrustedAction,
  loadTrustedPublicReadPolicy,
} from './trusted-public-policy.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const FORBIDDEN_CONFIG_KEY = /authorization|cookie|header|password|secret|token|credentialvalue|value/iu;
const ALLOWED_TOOLS = new Set(['execute_action']);
const FORBIDDEN_ARGUMENT_KEY = /confirm|raw[_-]?request|mutation|authorization|cookie|header|password|secret|token/iu;
const RAW_CREDENTIAL_SHAPE = /(?:^|[/:])(?:ghp|sk)[-_][A-Za-z0-9_-]{8,}/iu;
const SECRET_STORE_REGISTRY = Object.freeze({
  'os-keychain': Object.freeze({
    provenance: 'approved-secret-store',
    locator: /^[A-Za-z][A-Za-z0-9._-]{2,127}$/u,
  }),
});

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function validateCredentialRef(reference) {
  if (reference === null) return null;
  if (!isPlainObject(reference)) throw codedError('PROVIDER_CONFIG_INVALID', TypeError);
  const keys = Object.keys(reference).sort();
  if (
    reference.kind === 'environment'
    && keys.length === 2
    && keys[0] === 'kind'
    && keys[1] === 'name'
    && typeof reference.name === 'string'
    && /^[A-Z][A-Z0-9_]{0,127}$/u.test(reference.name)
  ) return Object.freeze({ kind: reference.kind, name: reference.name });
  if (
    reference.kind === 'secret-store'
    && keys.length === 4
    && keys[0] === 'kind'
    && keys[1] === 'provenance'
    && keys[2] === 'provider'
    && keys[3] === 'reference'
    && typeof reference.provider === 'string'
    && Object.hasOwn(SECRET_STORE_REGISTRY, reference.provider)
    && reference.provenance === SECRET_STORE_REGISTRY[reference.provider].provenance
    && typeof reference.reference === 'string'
    && SECRET_STORE_REGISTRY[reference.provider].locator.test(reference.reference)
    && !RAW_CREDENTIAL_SHAPE.test(reference.reference)
    && !/authorization|bearer|cookie|password|eyJ[a-zA-Z0-9_-]*\.|(?:^|[/:])(?:ghp|sk)_[a-zA-Z0-9_-]{8,}/iu.test(
      reference.reference,
    )
  ) return Object.freeze({
    kind: reference.kind,
    provider: reference.provider,
    provenance: reference.provenance,
    reference: reference.reference,
  });
  throw codedError('PROVIDER_CONFIG_INVALID', TypeError);
}

function validateProviderConfig(config) {
  if (!isPlainObject(config)) throw codedError('PROVIDER_CONFIG_INVALID', TypeError);
  const keys = Object.keys(config).sort();
  if (
    keys.length !== 6
    || keys[0] !== 'capabilityManifestHash'
    || keys[1] !== 'credentialRef'
    || keys[2] !== 'expectedLocationId'
    || keys[3] !== 'providerId'
    || keys[4] !== 'publicCatalogSnapshotHash'
    || keys[5] !== 'publicReadAllowlistHash'
    || keys.some((key) => FORBIDDEN_CONFIG_KEY.test(key) && key !== 'credentialRef')
    || typeof config.providerId !== 'string'
    || !SAFE_ID.test(config.providerId)
    || typeof config.expectedLocationId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(config.expectedLocationId)
    || typeof config.capabilityManifestHash !== 'string'
    || !SHA256.test(config.capabilityManifestHash)
    || typeof config.publicCatalogSnapshotHash !== 'string'
    || !SHA256.test(config.publicCatalogSnapshotHash)
    || typeof config.publicReadAllowlistHash !== 'string'
    || !SHA256.test(config.publicReadAllowlistHash)
  ) throw codedError('PROVIDER_CONFIG_INVALID', TypeError);
  return Object.freeze({
    providerId: config.providerId,
    expectedLocationId: config.expectedLocationId,
    capabilityManifestHash: config.capabilityManifestHash,
    publicCatalogSnapshotHash: config.publicCatalogSnapshotHash,
    publicReadAllowlistHash: config.publicReadAllowlistHash,
    credentialRef: validateCredentialRef(config.credentialRef),
  });
}

function containsForbiddenArgument(value, stack = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (stack.has(value)) return true;
  stack.add(value);
  try {
    return Reflect.ownKeys(value).some((key) => (
      typeof key !== 'string'
      || FORBIDDEN_ARGUMENT_KEY.test(key)
      || containsForbiddenArgument(value[key], stack)
    ));
  } finally {
    stack.delete(value);
  }
}

function collectLocationIndicators(value, indicators = [], stack = new WeakSet()) {
  if (!value || typeof value !== 'object' || stack.has(value)) return indicators;
  stack.add(value);
  try {
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      if (['boundlocationid', 'ghllocationid', 'locationid'].includes(normalized)) {
        indicators.push(nested);
      } else if (
        normalized === 'location'
        && nested
        && typeof nested === 'object'
        && !Array.isArray(nested)
        && Object.hasOwn(nested, 'id')
      ) {
        indicators.push(nested.id);
      }
      collectLocationIndicators(nested, indicators, stack);
    }
    return indicators;
  } finally {
    stack.delete(value);
  }
}

function validateTransport(transport) {
  if (!isPlainObject(transport)) throw codedError('MCP_TRANSPORT_INVALID', TypeError);
  if (transport.kind === 'streamable-http') {
    if (Object.keys(transport).some((key) => !['connect', 'fetch', 'kind', 'url'].includes(key))) {
      throw codedError('MCP_TRANSPORT_INVALID', TypeError);
    }
    if (typeof transport.url !== 'string') throw codedError('MCP_TRANSPORT_INVALID', TypeError);
    let url;
    try {
      url = new URL(transport.url);
    } catch {
      throw codedError('MCP_TRANSPORT_INVALID', TypeError);
    }
    if (
      (
        url.protocol !== 'https:'
        && !(
          url.protocol === 'http:'
          && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
        )
      )
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
    ) {
      throw codedError('MCP_TRANSPORT_INVALID', TypeError);
    }
    return Object.freeze({
      kind: transport.kind,
      url,
      connect: typeof transport.connect === 'function' ? transport.connect : null,
      fetch: typeof transport.fetch === 'function' ? transport.fetch : undefined,
    });
  }
  if (transport.kind === 'stdio') {
    if (Object.keys(transport).some((key) => !['args', 'command', 'connect', 'kind'].includes(key))) {
      throw codedError('MCP_TRANSPORT_INVALID', TypeError);
    }
    if (
      typeof transport.command !== 'string'
      || transport.command.length === 0
      || !Array.isArray(transport.args)
      || transport.args.some((argument) => typeof argument !== 'string')
      || transport.args.some((argument) => (
        /authorization|bearer|cookie|password|secret|token/iu.test(argument)
      ))
    ) throw codedError('MCP_TRANSPORT_INVALID', TypeError);
    return Object.freeze({
      kind: transport.kind,
      command: transport.command,
      args: Object.freeze([...transport.args]),
      connect: typeof transport.connect === 'function' ? transport.connect : null,
    });
  }
  throw codedError('MCP_TRANSPORT_INVALID', TypeError);
}

async function defaultConnect(transport, credential) {
  const client = new Client(
    { name: 'grom-weekly-audit', version: '1.0.0' },
    { capabilities: {} },
  );
  if (transport.kind === 'streamable-http') {
    const requestInit = credential === null
      ? undefined
      : { headers: { Authorization: `Bearer ${credential}` } };
    const sdkTransport = new StreamableHTTPClientTransport(transport.url, {
      requestInit,
      fetch: transport.fetch,
    });
    await client.connect(sdkTransport);
    return client;
  }
  const sdkTransport = new StdioClientTransport({
    command: transport.command,
    args: [...transport.args],
    stderr: 'pipe',
  });
  await client.connect(sdkTransport);
  return client;
}

function safeFailure(code) {
  return codedError(code);
}

export async function connectMcp({ transport, providerConfig, credentialResolver } = {}) {
  let config;
  let checkedTransport;
  try {
    config = validateProviderConfig(providerConfig);
    checkedTransport = validateTransport(transport);
  } catch (error) {
    if (error?.code === 'PROVIDER_CONFIG_INVALID') throw error;
    throw safeFailure('MCP_TRANSPORT_INVALID');
  }
  const trustedPolicy = loadTrustedPublicReadPolicy();
  if (
    config.publicCatalogSnapshotHash !== trustedPolicy.snapshotHash
    || config.publicReadAllowlistHash !== trustedPolicy.allowlistHash
  ) throw codedError('PROVIDER_CONFIG_INVALID', TypeError);

  let credential = null;
  if (config.credentialRef !== null) {
    try {
      if (typeof credentialResolver === 'function') {
        credential = await credentialResolver(config.credentialRef);
      } else if (config.credentialRef.kind === 'environment') {
        credential = process.env[config.credentialRef.name];
      } else {
        throw safeFailure('CREDENTIAL_RESOLUTION_FAILED');
      }
    } catch {
      throw safeFailure('CREDENTIAL_RESOLUTION_FAILED');
    }
    if (typeof credential !== 'string' || credential.length === 0) {
      throw safeFailure('CREDENTIAL_RESOLUTION_FAILED');
    }
  }

  let delegate;
  try {
    if (checkedTransport.connect) {
      delegate = checkedTransport.kind === 'streamable-http'
        ? await checkedTransport.connect({
          kind: checkedTransport.kind,
          url: checkedTransport.url.toString(),
          credential,
        })
        : await checkedTransport.connect({
          kind: checkedTransport.kind,
          command: checkedTransport.command,
          args: [...checkedTransport.args],
        });
    } else {
      delegate = await defaultConnect(checkedTransport, credential);
    }
  } catch {
    credential = null;
    throw safeFailure('MCP_CONNECTION_FAILED');
  }
  credential = null;
  if (!delegate || typeof delegate.callTool !== 'function') {
    try {
      await delegate?.close?.();
    } catch {
      // The connection is already unusable. Do not expose its failure details.
    }
    throw safeFailure('MCP_CONNECTION_FAILED');
  }

  return Object.freeze({
    providerId: config.providerId,
    expectedLocationId: config.expectedLocationId,
    capabilityManifestHash: config.capabilityManifestHash,
    publicCatalogSnapshotHash: trustedPolicy.snapshotHash,
    publicReadAllowlistHash: trustedPolicy.allowlistHash,
    async callTool(request, options) {
      if (!isPlainObject(request) || !ALLOWED_TOOLS.has(request.name)) {
        throw codedError('TOOL_NOT_AVAILABLE');
      }
      if (!isPlainObject(request.arguments) || containsForbiddenArgument(request.arguments)) {
        throw codedError('MUTATION_ARGUMENT_NOT_ALLOWED');
      }
      const policy = request.arguments.policy;
      try {
        assertTrustedAction(trustedPolicy, policy);
      } catch {
        throw codedError('ACTION_NOT_ALLOWED');
      }
      if (
        request.arguments.action !== policy.actionId
        || policy.providerId !== config.providerId
        || policy.capabilityManifestHash !== config.capabilityManifestHash
        || policy.sourceSnapshotHash !== config.publicCatalogSnapshotHash
        || policy.allowlistHash !== config.publicReadAllowlistHash
      ) throw codedError('ACTION_NOT_ALLOWED');
      if (
        !isPlainObject(request.arguments.params)
        || request.arguments.params.locationId !== config.expectedLocationId
        || collectLocationIndicators(request.arguments.params).some(
          (locationId) => locationId !== config.expectedLocationId,
        )
      ) throw codedError('LOCATION_MISMATCH');
      try {
        return await delegate.callTool({
          name: 'execute_action',
          arguments: {
            action: request.arguments.action,
            params: structuredClone(request.arguments.params),
          },
        }, options);
      } catch (error) {
        const rateLimited = error?.code === 429
          || error?.code === '429'
          || error?.code === 'RATE_LIMITED'
          || error?.status === 429;
        if (rateLimited) throw codedError('RATE_LIMITED');
        if (['RETRYABLE', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code)) {
          const retryable = codedError(error.code);
          if (
            Number.isInteger(error.retryAfterMs)
            && error.retryAfterMs >= 0
            && error.retryAfterMs <= 300_000
          ) retryable.retryAfterMs = error.retryAfterMs;
          throw retryable;
        }
        throw safeFailure('MCP_TOOL_CALL_FAILED');
      }
    },
    async close() {
      try {
        await delegate.close?.();
      } catch {
        throw safeFailure('MCP_CLOSE_FAILED');
      }
    },
  });
}

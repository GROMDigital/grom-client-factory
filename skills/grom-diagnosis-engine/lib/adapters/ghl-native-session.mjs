/**
 * THE GHL-NATIVE SESSION — the only thing in this repo that can open a real GoHighLevel MCP
 * session.
 *
 * `lib/adapters/mcp-transport.mjs` `defaultConnect` sends `Authorization: Bearer <credential>`.
 * That is correct for a server that already speaks our normalised contract, and it is WRONG for
 * every GHL MCP server this workspace actually has: those authenticate with a bespoke header
 * (`X-GHL-Token` today) and select the sub-account ENTIRELY from the token value — same URL, one
 * token per account. `mcp-transport.mjs` is deliberately untouched; this module fills the
 * `ghlNativeConnect` seam that `lib/local-runtime.mjs` already exposes for exactly this case.
 *
 * WHAT THIS MODULE PROMISES ABOUT THE CREDENTIAL
 *
 *  1. It never resolves one. `connectMcp` resolves the credential REFERENCE (environment variable
 *     or approved secret store) and hands the VALUE to this connect at connect time, once.
 *  2. The value is written into exactly one place — the `requestInit.headers` object handed to the
 *     SDK transport — and is never assigned to a module-level binding, never returned, never
 *     attached to an error, and never stringified.
 *  3. Nothing here logs. This module references no console and no standard-stream writer of any
 *     kind — asserted statically by the test suite — and every error it throws is a bare machine
 *     code with no interpolated value.
 *  4. The provider CONFIGURATION carries a reference and a header NAME. It cannot carry a token:
 *     `validateGhlNativeTransport` accepts three keys and none of them is a secret.
 *
 * The URL is validated with the same rules as `lib/adapters/mcp-transport.mjs:142-198` — https
 * only (or http on loopback for a local mock), no userinfo, no query, no fragment — so a
 * credential can never be smuggled into a query string and a downgrade to plaintext is refused.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { codedError } from './collection.mjs';

/**
 * The transport kind a provider configuration declares to get this session. It is a DIFFERENT
 * kind from `streamable-http` on purpose: a host that injects its own `ghlNativeConnect` keeps
 * working unchanged, and no existing configuration silently changes which dialect it speaks.
 */
export const GHL_NATIVE_TRANSPORT_KIND = 'ghl-native-streamable-http';

/** GoHighLevel MCP workers in this workspace authenticate with this header. Configurable. */
export const DEFAULT_GHL_CREDENTIAL_HEADER_NAME = 'X-GHL-Token';

/**
 * An RFC 7230 header field-name, conservatively narrowed. It must not be `Authorization` — that is
 * `defaultConnect`'s job and this module exists because it is the wrong one — and must not be a
 * hop-by-hop or cookie header, so a configuration cannot repurpose the credential slot into
 * something a proxy or a browser would treat specially.
 */
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;
const RESERVED_HEADER_NAMES = Object.freeze(new Set([
  'authorization',
  'connection',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]));

const CLIENT_IDENTITY = Object.freeze({ name: 'grom-weekly-audit', version: '1.0.0' });

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype,
  );
}

function transportInvalid() {
  throw codedError('MCP_TRANSPORT_INVALID', TypeError);
}

/**
 * The URL rules of `lib/adapters/mcp-transport.mjs:142-198`, applied to the GHL-native kind.
 * Returns the normalised absolute URL string.
 */
export function assertGhlNativeUrl(value) {
  if (typeof value !== 'string' || value.length === 0) transportInvalid();
  let url;
  try {
    url = new URL(value);
  } catch {
    return transportInvalid();
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
  ) transportInvalid();
  return url.toString();
}

/**
 * Exact-field validation of the transport record a provider configuration may declare. Three keys,
 * one of them optional, and no key that could hold a secret. A `connect` or `fetch` key — the two
 * things a JSON document cannot legitimately carry — is refused rather than silently discarded,
 * matching `validatePublicTransport` in `lib/local-runtime.mjs`.
 */
export function validateGhlNativeTransport(transport) {
  if (!isPlainObject(transport) || transport.kind !== GHL_NATIVE_TRANSPORT_KIND) transportInvalid();
  const keys = Object.keys(transport).sort().join(',');
  if (keys !== 'kind,url' && keys !== 'credentialHeaderName,kind,url') transportInvalid();
  const url = assertGhlNativeUrl(transport.url);
  const credentialHeaderName = Object.hasOwn(transport, 'credentialHeaderName')
    ? transport.credentialHeaderName
    : DEFAULT_GHL_CREDENTIAL_HEADER_NAME;
  if (
    typeof credentialHeaderName !== 'string'
    || !HEADER_NAME.test(credentialHeaderName)
    || RESERVED_HEADER_NAMES.has(credentialHeaderName.toLowerCase())
  ) transportInvalid();
  return Object.freeze({
    kind: GHL_NATIVE_TRANSPORT_KIND,
    url,
    credentialHeaderName,
  });
}

/**
 * Builds the `ghlNativeConnect` seam: a connect whose delegate is a RAW GHL MCP client.
 *
 * `lib/local-runtime.mjs` wraps the result in `createGhlTranslatingConnect` and hands THAT to
 * `connectMcp` as `transport.connect`, so the call order on a live run is:
 *
 *   connectMcp  →  resolve credentialRef  →  translatingConnect  →  THIS connect  →  MCP SDK
 *
 * `fetch` is an injectable seam for hermetic tests and for a host that wants to instrument the
 * wire. It is never supplied by a provider configuration — a JSON document cannot carry a
 * function, and `validateGhlNativeTransport` refuses the key outright.
 */
export function createGhlNativeConnect({
  url,
  credentialHeaderName = DEFAULT_GHL_CREDENTIAL_HEADER_NAME,
  fetch: fetchImplementation = undefined,
} = {}) {
  const checked = validateGhlNativeTransport({
    kind: GHL_NATIVE_TRANSPORT_KIND,
    url,
    credentialHeaderName,
  });
  if (fetchImplementation !== undefined && typeof fetchImplementation !== 'function') {
    transportInvalid();
  }
  return async function ghlNativeConnect(options) {
    // `connectMcp` calls a streamable-http connect with exactly `{ kind, url, credential }`, and
    // the URL it passes is the one IT validated. Both are re-checked here so this seam is safe to
    // call directly and cannot be pointed somewhere else by its caller.
    if (!isPlainObject(options) || options.kind !== 'streamable-http') transportInvalid();
    if (assertGhlNativeUrl(options.url) !== checked.url) transportInvalid();
    const credential = options.credential;
    if (typeof credential !== 'string' || credential.length === 0) {
      // A GHL worker selects the sub-account from the token alone, so an anonymous session is not
      // a degraded session — it is a session bound to NO account. Fail closed. The code names the
      // condition and carries nothing about the credential.
      throw codedError('GHL_NATIVE_CREDENTIAL_REQUIRED');
    }
    const client = new Client(CLIENT_IDENTITY, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(checked.url), {
      // The ONE place the value is written. `_commonHeaders` merges these into every request the
      // SDK makes on this session; the object is reachable only from the transport instance.
      requestInit: { headers: { [checked.credentialHeaderName]: credential } },
      ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
    });
    await client.connect(transport);
    /**
     * THE CALLING-CONVENTION BRIDGE, and it is load-bearing.
     *
     * Everything in this repo calls a delegate as `callTool(request, options)` — two arguments,
     * the second being `{ signal, timeout }` (`lib/adapters/ghl-public-translator.mjs:791`,
     * `lib/adapters/mcp-transport.mjs:328`). The installed SDK client is
     * `callTool(params, resultSchema = CallToolResultSchema, options)`, so handing the raw client
     * back would pass the OPTIONS OBJECT AS THE RESULT SCHEMA: the request goes out fine, the
     * reply comes back, and validation dies with `v3Schema.safeParse is not a function` — i.e.
     * every read fails after the account has already been contacted, surfacing as an opaque
     * `PUBLIC_COLLECTION_FAILED`. Bridged here, at the one place that owns the SDK client.
     *
     * Nothing is captured: `credential` is not referenced below this line, and the closure holds
     * only the client.
     */
    return Object.freeze({
      async callTool(request, options) {
        return client.callTool(request, undefined, options);
      },
      async close() {
        await client.close();
      },
    });
  };
}

/**
 * THE INTERNAL AUDIT SESSION — the only thing in this repo that can open a real session to the
 * GHL builder API.
 *
 * `lib/adapters/internal-ghl.mjs` shipped fully built and fully tested with NO transport at all:
 * `createLocalAuditKernel` takes an `internalClient` that some host is expected to inject, and
 * nothing in this repository ever injects one. So the internal half of the audit has never been
 * reachable from the CLI, for any configuration. That is the same gap the public half had until
 * `bd1fed8`, and this module is its counterpart.
 *
 * ---------------------------------------------------------------------------------------------
 * IT SPEAKS TO THE AUDIT SERVER, NEVER THE FULL ONE.
 *
 * The `uxie-ghl-factory` plugin bundles TWO servers. `dist/server.mjs` publishes 22 tools
 * including writes, confirmation-gated builders and a `raw_request` escape hatch.
 * `dist/audit-server.mjs` is a separate entry point with a separate registry that publishes
 * exactly six read tools, and its read-only-ness rests on two independent locks: a registry
 * filter no environment variable can widen, and a gateway wrapper under every tool that lets
 * only a GET to one of two approved origins leave the process.
 *
 * This module will launch ONLY that second artefact, by filename, and `assertAuditServerPath`
 * refuses anything else. An auditor that could reach the write server would be one
 * configuration mistake away from mutating a client's account, and no amount of care inside this
 * repository would make that acceptable.
 * ---------------------------------------------------------------------------------------------
 *
 * WHAT THIS MODULE PROMISES ABOUT THE CREDENTIAL
 *
 * More than the public rail can, because of how the server is built: the GHL session token is
 * read by the SERVER from a file whose PATH is handed over in `GHL_TOK_FILE`. So the token value
 * never enters this process at all. Nothing here reads it, holds it, or could log it, because it
 * never has it. The provider configuration carries a path; it cannot carry a secret.
 *
 * Nothing here logs. No console, no standard-stream writer, and every error is a bare machine
 * code with no interpolated value. The child's stderr is routed to `ignore` rather than inherited,
 * because the server writes credential-state diagnostics there.
 */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { codedError } from './collection.mjs';

/**
 * The transport kind a provider configuration declares to get this session. A DIFFERENT kind from
 * anything that exists, so no configuration silently changes which dialect it speaks and a host
 * that injects its own `internalClient` keeps working untouched.
 */
export const INTERNAL_AUDIT_TRANSPORT_KIND = 'ghl-internal-audit-stdio';

/** The ONLY filename this module will launch. See the module header. */
const AUDIT_SERVER_FILENAME = 'audit-server.mjs';

/**
 * The audit server's six tools, as its own registry declares them. Held here so a call to
 * anything outside the set is refused BEFORE it reaches the wire, rather than relying on the
 * far side to refuse it. Defence in depth over a boundary that guards a client's account.
 */
export const INTERNAL_AUDIT_TOOLS = Object.freeze([
  'auth_status',
  'export_workflow',
  'get_ai_configuration_bundle',
  'get_workflow',
  'get_workflow_runtime_window',
  'list_workflows_complete',
]);

const TOOL_SET = new Set(INTERNAL_AUDIT_TOOLS);

/**
 * Where a plugin build may live. The server is EXECUTED, so an unconstrained path is arbitrary
 * code execution driven by a config file. Confining it to the plugin cache under the running
 * user's home is not a defence against a hostile operator, who is the operator; it is a defence
 * against a typo, a copied config and a stale absolute path pointing at something else entirely.
 */
function pluginCacheRoot() {
  return join(homedir(), '.claude', 'plugins', 'cache');
}

function isWithin(parent, candidate) {
  const base = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return candidate === parent || candidate.startsWith(base);
}

/**
 * The path must be absolute, inside the plugin cache, a REGULAR FILE and not a symlink, and named
 * exactly `audit-server.mjs`. Both the lexical path and its REAL path are checked, because the
 * real path is what gets executed and a symlinked directory would otherwise walk straight out of
 * the cache. Same finding, same fix as `realWithin` in `lib/local-runtime.mjs`.
 */
export function assertAuditServerPath(value) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw codedError('INTERNAL_AUDIT_SERVER_PATH_INVALID', TypeError);
  }
  if (basename(value) !== AUDIT_SERVER_FILENAME) {
    throw codedError('INTERNAL_AUDIT_SERVER_NOT_AUDIT_PROFILE');
  }
  const root = pluginCacheRoot();
  const lexical = resolve(value);
  if (!isWithin(root, lexical)) throw codedError('INTERNAL_AUDIT_SERVER_PATH_OUTSIDE_CACHE');
  let real;
  try {
    real = realpathSync(lexical);
  } catch {
    throw codedError('INTERNAL_AUDIT_SERVER_UNREADABLE');
  }
  if (!isWithin(realpathSync(root), real)) {
    throw codedError('INTERNAL_AUDIT_SERVER_PATH_OUTSIDE_CACHE');
  }
  if (basename(real) !== AUDIT_SERVER_FILENAME) {
    throw codedError('INTERNAL_AUDIT_SERVER_NOT_AUDIT_PROFILE');
  }
  const metadata = lstatSync(lexical);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw codedError('INTERNAL_AUDIT_SERVER_UNREADABLE');
  }
  return real;
}

/**
 * The token FILE. A path, checked to exist and be a regular file, and never opened here. If it
 * cannot be read the server says so through `auth_status`, which is the one place credential
 * state belongs.
 */
export function assertTokenFilePath(value) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw codedError('INTERNAL_AUDIT_TOKEN_FILE_INVALID', TypeError);
  }
  let metadata;
  try {
    metadata = lstatSync(value);
  } catch {
    throw codedError('INTERNAL_AUDIT_TOKEN_FILE_UNREADABLE');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw codedError('INTERNAL_AUDIT_TOKEN_FILE_UNREADABLE');
  }
  return value;
}

/**
 * A provider configuration's internal transport record. THREE keys, and none of them is a
 * secret. There is deliberately no `env`, no `args` and no `command`: the command is `node`, the
 * argument is the validated audit-server path, and the only environment entry is the token file
 * path. A configuration that could set `args` could run anything.
 */
export function validateInternalAuditTransport(transport) {
  if (
    !transport
    || typeof transport !== 'object'
    || Array.isArray(transport)
    || transport.kind !== INTERNAL_AUDIT_TRANSPORT_KIND
  ) throw codedError('INTERNAL_AUDIT_TRANSPORT_INVALID', TypeError);
  const keys = Object.keys(transport).sort();
  /*
   * `serverPath` is OPTIONAL, and omitting it is the RECOMMENDED shape.
   *
   * 🔴 A pinned path is a version pin, and it goes stale silently. A provider config generated
   * against plugin 0.16.0 kept naming 0.16.0's `audit-server.mjs` after 0.16.1 shipped; the old
   * build is still on disk, so the run spawned it happily and would have re-inherited two defects
   * that had just been fixed. Nothing failed, nothing warned. Caught by hand on 2026-07-29.
   *
   * Omitted, the newest installed audit build is resolved at RUN time by
   * `discoverAuditServerPaths()`, which is the same newest-first resolution the generator used to
   * do ONCE at build time. The freeze was the bug, not the resolution.
   *
   * Every safety guard is unchanged either way: the resolved path still goes through
   * `assertAuditServerPath`, so it must be named `audit-server.mjs`, live inside the plugin cache
   * both lexically and after realpath, and not be a symlink. An explicit path is still honoured
   * for anyone deliberately pinning a build.
   */
  const allowed = new Set(['kind', 'serverPath', 'tokenFilePath']);
  if (
    keys.length < 2
    || keys.length > 3
    || keys.some((key) => !allowed.has(key))
    || !keys.includes('kind')
    || !keys.includes('tokenFilePath')
  ) throw codedError('INTERNAL_AUDIT_TRANSPORT_INVALID', TypeError);
  const serverPath = Object.hasOwn(transport, 'serverPath')
    ? assertAuditServerPath(transport.serverPath)
    : assertAuditServerPath(newestAuditServerPath());
  return Object.freeze({
    kind: INTERNAL_AUDIT_TRANSPORT_KIND,
    serverPath,
    tokenFilePath: assertTokenFilePath(transport.tokenFilePath),
  });
}

/**
 * The newest installed audit server, for a transport that did not pin one.
 *
 * Its own code rather than a bare index into `discoverAuditServerPaths()`, so "no audit build is
 * installed" is a NAMED failure. Falling through to `assertAuditServerPath(undefined)` would raise
 * INTERNAL_AUDIT_SERVER_PATH_INVALID, which reads as a malformed configuration and would send the
 * next operator hunting through their JSON for a typo that is not there.
 */
function newestAuditServerPath() {
  const [newest] = discoverAuditServerPaths();
  if (newest === undefined) throw codedError('INTERNAL_AUDIT_SERVER_NOT_INSTALLED');
  return newest;
}

/**
 * Resolve the newest installed plugin build that ships an audit server.
 *
 * The plugin's own launcher does exactly this, and for the same reason: pinning a version means a
 * plugin update silently breaks the path. It is exported so a configuration can be WRITTEN with a
 * concrete path (which is then validated on every run) rather than resolving late and auditing
 * against whatever happened to be installed at the time.
 */
export function discoverAuditServerPaths({ pluginId = 'uxieee/uxie-ghl-factory' } = {}) {
  const root = join(pluginCacheRoot(), ...pluginId.split('/'));
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const semverDescending = (left, right) => {
    const a = left.split('.').map((part) => Number.parseInt(part, 10));
    const b = right.split('.').map((part) => Number.parseInt(part, 10));
    for (let index = 0; index < 3; index += 1) {
      if ((a[index] || 0) !== (b[index] || 0)) return (b[index] || 0) - (a[index] || 0);
    }
    return 0;
  };
  return entries
    .filter((entry) => /^\d+\.\d+\.\d+$/u.test(entry))
    .sort(semverDescending)
    .map((version) => join(root, version, 'mcp-internal', 'dist', AUDIT_SERVER_FILENAME))
    .filter((candidate) => {
      try {
        return lstatSync(candidate).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * Open the session.
 *
 * Returns the SAME minimal surface `lib/adapters/internal-ghl.mjs` expects of an injected
 * `internalClient`: `listTools`, `callTool`, `close`. A tool outside the audit six is refused
 * locally with no request made.
 */
export function createInternalAuditConnect({
  serverPath,
  tokenFilePath,
  nodeExecutable = process.execPath,
} = {}) {
  const server = assertAuditServerPath(serverPath);
  const tokenFile = assertTokenFilePath(tokenFilePath);
  return async function connect() {
    const transport = new StdioClientTransport({
      command: nodeExecutable,
      args: [server],
      // EXACTLY one entry. The server inherits nothing else, so no credential, proxy setting or
      // debug flag from this process's environment can change how it behaves.
      env: { GHL_TOK_FILE: tokenFile },
      // The server writes credential-state diagnostics to stderr. Inheriting that would put them
      // in the operator's terminal and, worse, in whatever captures it.
      stderr: 'ignore',
    });
    const client = new Client(
      { name: 'ghl-account-audit', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return {
      async listTools() {
        return client.listTools();
      },
      async callTool(request) {
        const name = request?.name;
        if (typeof name !== 'string' || !TOOL_SET.has(name)) {
          throw codedError('INTERNAL_AUDIT_TOOL_NOT_PERMITTED');
        }
        return client.callTool(request);
      },
      async close() {
        await client.close();
      },
    };
  };
}

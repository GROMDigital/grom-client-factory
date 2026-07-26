import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const outputUrl = new URL('../dist/', import.meta.url);

/**
 * Binding the public MCP adapter into the CLI pulls `@modelcontextprotocol/sdk` into the bundle,
 * and its stdio transport depends on `cross-spawn`, which is CommonJS and calls
 * `require('child_process')`. esbuild's ESM output rewrites that to a `__require` shim whose
 * fallback THROWS `Dynamic require of "child_process" is not supported` — at module init, so the
 * bundled CLI died before it could parse a single flag, for every command, including the offline
 * `local_fixture` run.
 *
 * The banner defines a real `require` in module scope before esbuild's shim is evaluated, so the
 * shim resolves to it. Node-only, which this bundle already is (`platform: 'node'`).
 */
const NODE_REQUIRE_BANNER = [
  "import { createRequire as __auditCreateRequire } from 'node:module';",
  'const require = __auditCreateRequire(import.meta.url);',
].join('\n');

export async function bundleRuntime() {
  mkdirSync(outputUrl, { recursive: true });
  await Promise.all([
    build({
      entryPoints: [fileURLToPath(new URL('../schemas/v1.mjs', import.meta.url))],
      outfile: fileURLToPath(new URL('audit-runtime-contracts.mjs', outputUrl)),
      bundle: true,
      external: ['zod'],
      format: 'esm',
      platform: 'node',
      target: 'node24',
      sourcemap: false,
    }),
    build({
      entryPoints: [fileURLToPath(new URL('../cli/audit.mjs', import.meta.url))],
      outfile: fileURLToPath(new URL('audit-cli.mjs', outputUrl)),
      banner: { js: NODE_REQUIRE_BANNER },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      sourcemap: false,
    }),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundleRuntime();

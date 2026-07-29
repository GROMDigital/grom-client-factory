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
    /*
     * ARCHIVING IS PART OF THE PRODUCT, so it ships like the CLI does.
     *
     * 🔴 `scripts/archive-run.mjs` was source-only, and the installed plugin ships `dist/` with no
     * `node_modules`, so filing a finished run could not be done from the installed tool at all: it
     * failed on a zod resolution and had to be run out of a worktree at the matching commit. Every
     * audit ends with this step, so "works only from a checkout" meant every audit ended outside
     * the shipped product.
     *
     * Bundled WITHOUT `external: ['zod']`, unlike `audit-runtime-contracts.mjs` above, because the
     * whole point is to carry its dependencies. It resolves `SKILL` as `<dir>/..`, and `dist/` sits
     * directly under the skill root, so the profile and data paths it reads still resolve.
     */
    build({
      entryPoints: [fileURLToPath(new URL('../scripts/archive-run.mjs', import.meta.url))],
      outfile: fileURLToPath(new URL('archive-run.mjs', outputUrl)),
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

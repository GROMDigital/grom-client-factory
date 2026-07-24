import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const outputUrl = new URL('../dist/', import.meta.url);

export async function bundleRuntime() {
  mkdirSync(outputUrl, { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL('../schemas/v1.mjs', import.meta.url))],
    outfile: fileURLToPath(new URL('audit-runtime-contracts.mjs', outputUrl)),
    bundle: true,
    external: ['zod'],
    format: 'esm',
    platform: 'node',
    target: 'node24',
    sourcemap: false,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundleRuntime();

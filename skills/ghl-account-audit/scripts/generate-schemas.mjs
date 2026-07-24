import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as contracts from '../schemas/v1.mjs';

const outputUrl = new URL('../schemas/generated/', import.meta.url);

export function generateSchemas() {
  mkdirSync(outputUrl, { recursive: true });
  const schemas = Object.entries(contracts)
    .filter(([name, value]) => name.endsWith('Schema') && value && typeof value === 'object' && '_zod' in value)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [name, schema] of schemas) {
    const output = `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`;
    writeFileSync(new URL(`${name}.schema.json`, outputUrl), output);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) generateSchemas();

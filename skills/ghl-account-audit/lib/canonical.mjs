import { createHash } from 'node:crypto';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  const json = JSON.stringify(canonicalize(value));
  if (json === undefined) throw new TypeError('CANONICAL_JSON_UNSUPPORTED');
  return json;
}

export function sha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

#!/usr/bin/env node
// Redact secrets from a captured GHL JSON file so captures/<date>/ can be committed.
// Usage: sanitize_capture.mjs <in.json> <out.json>   (writes sanitized copy)
//        sanitize_capture.mjs --check <in.json>       (exit 1 if anything would be redacted)
import fs from "node:fs";

const KEY_SECRET = /^(.*(token|api[_-]?key|secret|password|jwt|bearer).*)$/i;
const REDACTED_MARKER = /^<REDACTED:[a-z-]+>$/;
// Value-shape patterns, applied as in-place global replacements so a secret
// embedded in a longer string (a webhook URL, an "Authorization: ..." header
// carried as an array element) is redacted in place, not only when it is the
// whole value. Order matters: bearer consumes "Bearer <jwt>" before the bare
// jwt pattern could split it.
const VALUE_PATTERNS = [
  ["bearer", /Bearer\s+\S+/gi],
  ["meta-capi", /EAA[A-Za-z0-9]{20,}/g],
  ["jwt", /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g],
];

const checkMode = process.argv[2] === "--check";
const inPath = checkMode ? process.argv[3] : process.argv[2];
const outPath = checkMode ? null : process.argv[3];
if (!inPath || (!checkMode && !outPath)) {
  console.error("usage: sanitize_capture.mjs <in.json> <out.json> | --check <in.json>");
  process.exit(2);
}

const redactions = [];
// Redact one string value. key is "" for array elements and other keyless
// scalars. Returns the possibly-redacted string; pushes one record per hit.
function redactString(key, val, jsonPath) {
  if (REDACTED_MARKER.test(val)) return val; // idempotent: never re-redact a marker
  if (/^cookie$/i.test(key)) {
    redactions.push(`REDACTED\t${jsonPath}\tcookie`);
    return "<REDACTED:cookie>";
  }
  let out = val;
  let hit = false;
  for (const [kind, pattern] of VALUE_PATTERNS) {
    out = out.replace(pattern, () => {
      redactions.push(`REDACTED\t${jsonPath}\t${kind}`);
      hit = true;
      return `<REDACTED:${kind}>`;
    });
  }
  if (hit) return out;
  if (KEY_SECRET.test(key)) {
    redactions.push(`REDACTED\t${jsonPath}\tsecret-key`);
    return "<REDACTED:secret-key>";
  }
  return val;
}

function walk(node, jsonPath, key) {
  if (typeof node === "string") return redactString(key, node, jsonPath);
  if (Array.isArray(node)) return node.map((v, i) => walk(v, `${jsonPath}[${i}]`, ""));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, `${jsonPath}.${k}`, k);
    return out;
  }
  return node;
}

const data = JSON.parse(fs.readFileSync(inPath, "utf8"));
const sanitized = walk(data, "$", "");
if (redactions.length) console.log(redactions.join("\n"));
if (checkMode) process.exit(redactions.length ? 1 : 0);
fs.writeFileSync(outPath, JSON.stringify(sanitized, null, 2) + "\n");
process.exit(0);

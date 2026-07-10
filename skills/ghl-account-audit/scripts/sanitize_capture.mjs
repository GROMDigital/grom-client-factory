#!/usr/bin/env node
// Redact secrets from a captured GHL JSON file so captures/<date>/ can be committed.
// Usage: sanitize_capture.mjs <in.json> <out.json>   (writes sanitized copy)
//        sanitize_capture.mjs --check <in.json>       (exit 1 if anything would be redacted)
import fs from "node:fs";

const KEY_SECRET = /^(.*(token|api[_-]?key|secret|password|jwt|bearer).*)$/i;
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const META_CAPI = /^EAA[A-Za-z0-9]{20,}$/;
const BEARER = /^Bearer\s+\S+$/i;

const checkMode = process.argv[2] === "--check";
const inPath = checkMode ? process.argv[3] : process.argv[2];
const outPath = checkMode ? null : process.argv[3];
if (!inPath || (!checkMode && !outPath)) {
  console.error("usage: sanitize_capture.mjs <in.json> <out.json> | --check <in.json>");
  process.exit(2);
}

const redactions = [];
function classify(key, val) {
  if (typeof val !== "string") return null;
  if (/^cookie$/i.test(key)) return "cookie";
  if (BEARER.test(val)) return "bearer";
  if (META_CAPI.test(val)) return "meta-capi";
  if (JWT.test(val)) return "jwt";
  if (KEY_SECRET.test(key)) return "secret-key";
  return null;
}
function walk(node, jsonPath) {
  if (Array.isArray(node)) return node.map((v, i) => walk(v, `${jsonPath}[${i}]`));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const kind = classify(k, v);
      if (kind) {
        redactions.push(`REDACTED\t${jsonPath}.${k}\t${kind}`);
        out[k] = `<REDACTED:${kind}>`;
      } else {
        out[k] = walk(v, `${jsonPath}.${k}`);
      }
    }
    return out;
  }
  return node;
}

const data = JSON.parse(fs.readFileSync(inPath, "utf8"));
const sanitized = walk(data, "$");
if (redactions.length) console.log(redactions.join("\n"));
if (checkMode) process.exit(redactions.length ? 1 : 0);
fs.writeFileSync(outPath, JSON.stringify(sanitized, null, 2) + "\n");
process.exit(0);

#!/usr/bin/env node
// Mechanical Tier-1 floor for a Grom client folder. Usage: node validate.mjs <client-folder>
// Prints one violation per line: RULE\tfile\tdetail. Exit 0 pass / 1 violations.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "client-manifest.schema.json"), "utf8"));
const CANONICAL = schema.properties.stage_map.additionalProperties.enum.filter((v) => v !== null);
const LP_EVENTS = new Set(["lp_view", "booking_started", "booking_cta_clicked", "booking_submitted", "offer_viewed"]);
const PLATFORM = /gohighlevel|highlevel(?!\.stoplight)|(?<![a-z])ghl(?![a-z-])/i;

const root = process.argv[2];
if (!root || !fs.existsSync(root)) { console.error("usage: validate.mjs <client-folder>"); process.exit(2); }
const violations = [];
const v = (rule, file, detail) => violations.push(`${rule}\t${file}\t${detail}`);

// 1. Manifest
const manifestPath = path.join(root, "client-manifest.json");
if (!fs.existsSync(manifestPath)) {
  v("MANIFEST_MISSING", "client-manifest.json", "no manifest at client-folder root");
} else {
  let m = null;
  try { m = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch (e) { v("MANIFEST_INVALID_JSON", "client-manifest.json", e.message); }
  if (m) {
    for (const req of schema.required) if (!(req in m)) v("MANIFEST_REQUIRED_FIELD", "client-manifest.json", `missing ${req}`);
    for (const [stage, step] of Object.entries(m.stage_map ?? {}))
      if (step !== null && !CANONICAL.includes(step)) v("MANIFEST_BAD_CANONICAL_STEP", "client-manifest.json", `${stage} -> ${step}`);
  }
}

// 2. Text scans
const walk = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((d) => d.isFile()).map((d) => path.join(d.parentPath ?? d.path, d.name))
  : [];
const rel = (f) => path.relative(root, f);

for (const f of [...walk(path.join(root, "design")), ...walk(path.join(root, "lp")), ...walk(path.join(root, "build"))]) {
  if (!/\.(md|html|json|txt)$/i.test(f)) continue;
  const text = fs.readFileSync(f, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.includes("\u2014")) v("EM_DASH", rel(f), `line ${i + 1}`);
    const badToken = line.match(/\{\{FILL_(?![A-Z0-9_]+\}\})[^}]*\}\}/);
    if (badToken) v("MALFORMED_FILL_TOKEN", rel(f), `line ${i + 1}: ${badToken[0]}`);
  });
  if (rel(f).startsWith("lp" + path.sep)) {
    lines.forEach((line, i) => {
      if (PLATFORM.test(line)) v("PLATFORM_NAME_IN_LP", rel(f), `line ${i + 1}`);
      for (const call of line.matchAll(/gromCapture\(\s*['"]([^'"]+)['"]/g))
        if (!LP_EVENTS.has(call[1])) v("BAD_LP_EVENT", rel(f), `line ${i + 1}: ${call[1]}`);
    });
  }
}

if (violations.length) { console.log(violations.join("\n")); process.exit(1); }
console.log("validate: PASS");

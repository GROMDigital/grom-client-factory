#!/usr/bin/env node
// Go-live gate: every execution-discovered manifest field must be filled.
// Usage: golive_check.mjs <client-manifest.json>. Exit 0 ready / 1 gaps / 2 usage.
import fs from "node:fs";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error("usage: golive_check.mjs <client-manifest.json>"); process.exit(2); }
const m = JSON.parse(fs.readFileSync(file, "utf8"));
const gaps = [];

const resolve = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
for (const [field, lifecycle] of Object.entries(m.field_lifecycle ?? {})) {
  if (lifecycle !== "execution-discovered") continue;
  const val = resolve(m, field);
  if (val === null || val === undefined || val === "") gaps.push(`GOLIVE_GAP\t${field}\texecution-discovered field is null/missing`);
}
if (m.ids_harvested !== true) gaps.push("GOLIVE_GAP\tids_harvested\tmanifest IDs not harvested from live account");

if (gaps.length) { console.log(gaps.join("\n")); process.exit(1); }
console.log("golive_check: READY");

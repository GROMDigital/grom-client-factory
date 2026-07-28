#!/usr/bin/env node
// Deterministic repair of the mechanical conformance rules.
// Usage: node conformance_fix.mjs <client-folder> [--dry-run]
// Prints one action per line on stdout: ACTION\tfile\tdetail. Always exits 0;
// what it could not repair is left for validate.mjs to report as normal.
//
// Why this is code and not an agent. On 2026-07-28 the factory dispatched 24
// `fix-conformance` agents. Three of them hit CLAIMS_ORPHAN_SIDECAR, a rule
// their prompt had no instruction for, improvised, and DELETED five sidecars
// carrying 25 fill tokens between them. The system built to guarantee every
// token reaches the client destroyed that guarantee for five documents. None of
// the work those agents did needed judgement: renaming a file to match its
// document, adding a token to a list, removing one that is not there. Judgement
// is exactly what produced the deletions.
//
// The one inviolable rule here: THIS TOOL NEVER DELETES A FILE. Not an orphan,
// not a duplicate, not an unparseable one. The worst outcome it will accept is
// leaving something for a human to look at.
import fs from "node:fs";
import path from "node:path";
import {
  bareToken, canonicalClaimsDir, claimsDirs as claimsDirsFor,
  docTokenIndex, resolveOrphanKey,
} from "./lib/docscan.mjs";

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const root = process.argv.slice(2).find((a) => !a.startsWith("--"));
const DRY = flags.has("--dry-run");

if (!root || !fs.existsSync(root)) {
  console.error("usage: conformance_fix.mjs <client-folder> [--dry-run]");
  process.exit(2);
}

const actions = [];
const act = (kind, file, detail) => actions.push(`${kind}\t${file}\t${detail}`);
const rel = (f) => path.relative(root, f);
const write = (f, data) => { if (!DRY) fs.writeFileSync(f, data); };

// ---------------------------------------------------------- 1. Parse repair
// Two failure modes are real and mechanically undoable: an agent wrapping its
// JSON in a markdown fence, and a trailing comma. Anything else is left alone,
// because guessing at the contents of a token registry is how tokens go
// missing. The original bytes are never destroyed: a repair only lands if the
// repaired text parses.
const unfence = (s) => s.replace(/^﻿/, "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
const untrailing = (s) => s.replace(/,(\s*[}\]])/g, "$1");

const readSidecar = (full) => {
  const raw = fs.readFileSync(full, "utf8");
  try { return { data: JSON.parse(raw), repaired: false }; } catch { /* fall through */ }
  for (const candidate of [unfence(raw), untrailing(raw), untrailing(unfence(raw))]) {
    try {
      const data = JSON.parse(candidate);
      write(full, JSON.stringify(data, null, 2) + "\n");
      act("REPAIRED_JSON", rel(full), "reformatted a sidecar that did not parse; contents unchanged");
      return { data, repaired: true };
    } catch { /* try the next candidate */ }
  }
  act("UNFIXABLE", rel(full), "sidecar does not parse and is not mechanically repairable; left untouched");
  return null;
};

// ------------------------------------------------------- 2. Orphan renames
// A sidecar named `build-overview.json` beside a doc named `00-build-overview.md`
// is numbering drift. Renaming is deterministic when exactly one document
// matches. When none or several do, it is LEFT IN PLACE and reported.
// Paths a rename has already claimed. Under --dry-run nothing moves on disk, so
// without this the report says "renamed X -> Y" and then "created Y", which
// reads as two conflicting actions on one file.
const planned = new Set();

let index = docTokenIndex(root);
for (const cdir of claimsDirsFor(root)) {
  for (const file of fs.readdirSync(cdir).filter((f) => f.endsWith(".json"))) {
    const key = file.replace(/\.json$/, "");
    if (index.has(key)) continue;
    const target = resolveOrphanKey(key, index);
    if (!target) {
      act("UNFIXABLE", rel(path.join(cdir, file)),
        `no document matches ${key}; left in place for a human, NOT deleted`);
      continue;
    }
    const to = path.join(cdir, `${target}.json`);
    if (fs.existsSync(to)) {
      act("UNFIXABLE", rel(path.join(cdir, file)),
        `would rename to ${target}.json but that already exists; left in place, NOT deleted`);
      continue;
    }
    if (!DRY) fs.renameSync(path.join(cdir, file), to);
    planned.add(to);
    act("RENAMED_SIDECAR", rel(path.join(cdir, file)), `-> ${target}.json (numbering drift, same document)`);
  }
}

// --------------------------------------- 3. Missing sidecars and token sync
index = docTokenIndex(root);
const canonical = canonicalClaimsDir(root);
// ALL of them, not the first. A document can have a sidecar in design/claims/
// and another in build/<run>/claims/, and the validator fails on a defect in
// either, so repairing only the first leaves a violation nothing will clear.
const sidecarPaths = (key) => {
  const found = claimsDirsFor(root)
    .map((d) => path.join(d, `${key}.json`))
    .filter((p) => fs.existsSync(p) || planned.has(p));
  return found;
};
const isDerivedRender = (entry) =>
  entry.files.every((f) => path.resolve(path.dirname(f)) === path.resolve(root) && /\.html$/i.test(f));

for (const [key, entry] of index) {
  if (!entry.tokens.size || isDerivedRender(entry)) continue;
  const existing = sidecarPaths(key);

  if (!existing.length) {
    const full = path.join(canonical, `${key}.json`);
    if (!DRY) fs.mkdirSync(canonical, { recursive: true });
    write(full, JSON.stringify({
      defines: { fill_tokens: [...entry.tokens].sort() },
      references: { fill_tokens: [] },
    }, null, 2) + "\n");
    act("CREATED_SIDECAR", rel(full), `${entry.tokens.size} token(s) from ${key}`);
    continue;
  }
  if (existing.length > 1) {
    act("NOTE", rel(existing[0]),
      `${key} has ${existing.length} sidecars (${existing.map(rel).join(", ")}); all are repaired, none is removed`);
  }

  for (const full of existing) syncSidecar(full, entry);
}

function syncSidecar(full, entry) {
  if (!fs.existsSync(full)) return; // a dry-run rename target that does not exist yet
  const parsed = readSidecar(full);
  if (!parsed) return;
  const sc = parsed.data ?? {};
  sc.defines ??= { fill_tokens: [] };
  sc.references ??= { fill_tokens: [] };
  sc.defines.fill_tokens ??= [];
  sc.references.fill_tokens ??= [];

  const declared = new Map(); // bare token -> which side it was declared on
  for (const side of ["defines", "references"]) {
    for (const t of sc[side].fill_tokens) declared.set(bareToken(t), side);
  }

  const added = [];
  for (const t of entry.tokens) {
    if (!declared.has(t)) { sc.defines.fill_tokens.push(t); added.push(t); }
  }
  // A token the sidecar claims and the document does not contain asks the
  // client a question nothing consumes. Dropping the claim is safe; the token
  // was never in the document, so nothing loses a home.
  const removed = [];
  for (const side of ["defines", "references"]) {
    sc[side].fill_tokens = sc[side].fill_tokens.filter((t) => {
      if (entry.tokens.has(bareToken(t))) return true;
      removed.push(bareToken(t));
      return false;
    });
  }

  if (added.length || removed.length) {
    sc.defines.fill_tokens = [...new Set(sc.defines.fill_tokens.map(bareToken))].sort();
    sc.references.fill_tokens = [...new Set(sc.references.fill_tokens.map(bareToken))].sort();
    write(full, JSON.stringify(sc, null, 2) + "\n");
    if (added.length) act("DECLARED_TOKENS", rel(full), `added ${added.join(", ")}`);
    if (removed.length) act("DROPPED_PHANTOMS", rel(full), `removed ${removed.join(", ")}`);
  }
}

// ------------------------------------------------------------------ Report
console.error(`conformance_fix: ${actions.length} action(s)${DRY ? " (dry run, nothing written)" : ""}`);
console.log(actions.length ? actions.join("\n") : "conformance_fix: NOTHING TO DO");

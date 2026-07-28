// Cross-document name reconciliation, in code.
//
// Names are load-bearing in a Grom build (guardrail 6): a workflow filters on
// the exact string, so `Deposit Paid` and `deposit-paid` are two different tags
// to the platform and a respelling is a broken build. The registry-reconciler
// AGENT has always checked this, and most of what it does is set comparison:
// is this name in that list. Code does that exactly, free, on every run, and
// crucially it can report the LINE, which the agent could not: on 2026-07-28 a
// fix pass spent 56 shell commands to make 23 edits purely on locating things.
//
// What is deliberately NOT here is judgement. Code can say two names normalise
// to the same string; it cannot say whether they MEAN the same thing, or
// whether one fill token is standing in for two different unknowns. Those stay
// with the agent, and this pass exists partly to hand it a shorter list.
//
// 🔴 This runs ALONGSIDE the agent, not instead of it, until one real build has
// compared the two. The estate's own lesson (2026-07-27, and again on 07-28) is
// that cutting an agent on a guess about what it contributes gets it wrong.
import fs from "node:fs";
import path from "node:path";
import { AUTHORED_EXT, claimsDirs, isClaimsPath, scannedFiles } from "./docscan.mjs";

const CATEGORIES = ["workflows", "tags", "fields", "alerts", "calendars", "products", "fill_tokens"];

// The architect's sidecar is the master set: it defines every structural name.
const isRegistryKey = (key) => /architecture-final/.test(key);

// Two names collide when they differ only in the ways a human does not notice
// and a string comparison does: case, punctuation, spacing, a trailing plural.
export const normalise = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/s$/, "");

// Where a name appears, so a finding can carry a line instead of a search.
const locate = (root, name) => {
  const needle = String(name).trim();
  if (!needle) return null;
  for (const f of scannedFiles(root)) {
    if (!AUTHORED_EXT.test(f) || isClaimsPath(root, f)) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        return { file: path.relative(root, f), line: i + 1, anchor: lines[i].trim().slice(0, 120) };
      }
    }
  }
  return null;
};

export const reconcile = (root) => {
  const findings = [];
  const sidecars = [];
  for (const dir of claimsDirs(root)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        sidecars.push({
          key: file.replace(/\.json$/, ""),
          rel: path.relative(root, path.join(dir, file)),
          data: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")),
        });
      } catch { /* CLAIMS_INVALID_JSON is the claims pass's job, not this one */ }
    }
  }
  if (!sidecars.length) return { findings, inspected: 0 };

  const listOf = (sc, side, cat) => {
    const v = sc.data?.[side]?.[cat];
    return Array.isArray(v) ? v.map((x) => String(x).replace(/^\{\{|\}\}$/g, "").trim()).filter(Boolean) : [];
  };

  for (const cat of CATEGORIES) {
    // who defines what
    const definedBy = new Map(); // name -> [sidecar keys]
    for (const sc of sidecars) {
      for (const n of listOf(sc, "defines", cat)) {
        if (!definedBy.has(n)) definedBy.set(n, []);
        if (!definedBy.get(n).includes(sc.key)) definedBy.get(n).push(sc.key);
      }
    }

    // 1. a reference nothing defines. The build cites a name that no document
    //    owns, which at runtime is a filter that matches nothing.
    for (const sc of sidecars) {
      for (const n of listOf(sc, "references", cat)) {
        if (definedBy.has(n)) continue;
        const where = locate(root, n);
        findings.push({
          rule: "RECONCILE_UNDEFINED_REFERENCE",
          category: cat,
          name: n,
          sidecar: sc.rel,
          ...(where ?? {}),
          detail: `${sc.key} references ${cat.slice(0, -1)} "${n}" and no document defines it`,
        });
      }
    }

    // 2. one name, two owners. Excludes the registry, which legitimately
    //    defines everything a module later also claims to define.
    //    🔴 STRUCTURAL names only. Measured on the real Better By Ati build,
    //    applying this to fill_tokens produced 15 findings of one shape: several
    //    documents each writing {{FILL_OPENING_HOURS}} and each calling it a
    //    definition. That is ordinary, the fill guide dedupes it, and drowning
    //    the two genuine structural clashes in it would defeat the pass.
    if (cat !== "fill_tokens") for (const [n, owners] of definedBy) {
      const nonRegistry = owners.filter((o) => !isRegistryKey(o));
      if (nonRegistry.length > 1) {
        const where = locate(root, n);
        findings.push({
          rule: "RECONCILE_DUPLICATE_DEFINITION",
          category: cat,
          name: n,
          sidecar: nonRegistry.join(", "),
          ...(where ?? {}),
          detail: `${cat.slice(0, -1)} "${n}" is defined by ${nonRegistry.join(" and ")}; exactly one document owns a name`,
        });
      }
    }

    // 3. names that differ only in shape. Reported as CANDIDATES, because
    //    whether they mean the same thing is a judgement no script can make.
    const all = new Set();
    for (const sc of sidecars) for (const side of ["defines", "references"]) for (const n of listOf(sc, side, cat)) all.add(n);
    const byShape = new Map();
    for (const n of all) {
      const k = normalise(n);
      if (!k) continue;
      if (!byShape.has(k)) byShape.set(k, new Set());
      byShape.get(k).add(n);
    }
    for (const [, variants] of byShape) {
      if (variants.size < 2) continue;
      const list = [...variants];
      const where = locate(root, list[1]);
      findings.push({
        rule: "RECONCILE_NAME_COLLISION_CANDIDATE",
        category: cat,
        name: list.join(" | "),
        sidecar: "",
        ...(where ?? {}),
        detail: `${list.map((x) => `"${x}"`).join(" and ")} differ only in case, punctuation or plural; if they are one thing the registry spelling wins, and if they are genuinely two, say so`,
      });
    }
  }

  return { findings, inspected: sidecars.length };
};

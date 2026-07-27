import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(here, "..", "validate.mjs");
const fixture = (name) => path.join(here, "fixtures", name);

function run(folder, ...flags) {
  const r = spawnSync("node", [validator, folder, ...flags], { encoding: "utf8" });
  // stdout carries the machine-readable violations; stderr carries the coverage report.
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("valid client folder passes", () => {
  const r = run(fixture("valid"));
  assert.equal(r.code, 0, r.out);
});

test("invalid folder fails and names every violated rule", () => {
  const r = run(fixture("invalid"));
  assert.equal(r.code, 1);
  const expected = [
    ["MANIFEST_REQUIRED_FIELD", "client-manifest.json"],
    ["MANIFEST_BAD_CANONICAL_STEP", "client-manifest.json"],
    ["EM_DASH", path.join("design", "01-brief.md")],
    ["MALFORMED_FILL_TOKEN", path.join("design", "01-brief.md")],
    ["PLATFORM_NAME_IN_LP", path.join("lp", "index.html")],
    ["BAD_LP_EVENT", path.join("lp", "index.html")],
  ];
  for (const [rule, file] of expected) {
    const pat = new RegExp("^" + rule + "\\t" + file.replace(/[.\\]/g, "\\$&") + "\\t", "m");
    assert.match(r.out, pat, `expected ${rule} on ${file} in output:\n${r.out}`);
  }
});

test("missing manifest is its own rule", () => {
  const r = run(fixture("no-manifest"));
  assert.equal(r.code, 1);
  assert.match(r.out, /MANIFEST_MISSING/);
});

test("malformed manifest JSON is its own rule", () => {
  const r = run(fixture("bad-json"));
  assert.equal(r.code, 1);
  assert.match(r.out, /MANIFEST_INVALID_JSON/);
});

test("a clean Standard Build folder passes", () => {
  const r = run(fixture("valid-v2"));
  assert.equal(r.code, 0, r.out);
});

test("a broken Standard Build folder names every violated rule", () => {
  const r = run(fixture("invalid-v2"));
  assert.equal(r.code, 1);
  const expected = [
    // manifest, v2 contracts
    "MANIFEST_MISSING_STAGE",          // a renamed stage is a missing stage
    "MANIFEST_ZERO_OFFER_PRICE",
    "MANIFEST_DUPLICATE_FUNNEL_SLUG",
    "MANIFEST_BAD_WORKFLOW_NUMBER",
    "MANIFEST_MISSING_BASE_WORKFLOW",
    "MANIFEST_MISSING_LOST_REASON",
    "MANIFEST_MISSING_PER_CYCLE_FIELD",
    "MANIFEST_KNOB_RELATION",
    // workflow JSON
    "WF_NOT_PUBLISHED",                // the deployment gate, half 1
    "WF_TRIGGER_FILE_EMPTY",           // the deployment gate, half 2
    "WF_STOP_ON_RESPONSE_OFF",
    "WF_FINDER_NOT_PIPELINE_ONLY",
    "WF_NOT_FOUND_DEAD_END",
    "WF_MONETARY_VALUE_SHAPE",
    "WF_STAGE_WITHOUT_PIPELINE",
    "WF_MISSING_ALLOW_BACKWARD",
    "WF_APPT_WAIT_NO_PAST_BRANCH",
    "WF_GOTO_UNRESOLVED",
  ];
  for (const rule of expected) {
    assert.match(r.out, new RegExp("^" + rule + "\\t", "m"), `expected ${rule} in output:\n${r.out}`);
  }
});

// --- claims sidecar pass -------------------------------------------------
// These checks exist so agents stop grepping their own output to enforce
// guardrail 3. Centralised, they run every time and cannot be skipped.

test("a doc whose tokens all match its sidecar passes conformance", () => {
  const r = run(fixture("claims-clean"), "--conformance");
  assert.equal(r.code, 0, r.out);
});

test("claims mismatches are each their own rule", () => {
  const r = run(fixture("claims-broken"), "--conformance");
  assert.equal(r.code, 1);
  for (const rule of [
    "CLAIMS_INVALID_JSON",        // a sidecar that will not parse
    "CLAIMS_TOKEN_UNDECLARED",    // token in the doc, absent from the sidecar
    "CLAIMS_TOKEN_PHANTOM",       // token in the sidecar, absent from the doc
    "CLAIMS_SIDECAR_MISSING",     // doc carries tokens and has no sidecar at all
    "CLAIMS_ORPHAN_SIDECAR",      // sidecar guarding a doc that does not exist
  ]) {
    assert.match(r.out, new RegExp("^" + rule + "\\t", "m"), `expected ${rule} in output:\n${r.out}`);
  }
});

test("sidecar tokens match with or without braces", () => {
  // claims-clean declares one token braced and one bare; neither may be flagged.
  const r = run(fixture("claims-clean"), "--conformance");
  assert.doesNotMatch(r.out, /CLAIMS_TOKEN_(UNDECLARED|PHANTOM)/);
});

test("--conformance skips the manifest pass rather than failing on it", () => {
  // claims-clean has no manifest at all. Without the flag that is a violation.
  const scoped = run(fixture("claims-clean"), "--conformance");
  assert.equal(scoped.code, 0, scoped.out);
  assert.doesNotMatch(scoped.out, /MANIFEST_MISSING/);
  assert.match(scoped.err, /manifest and workflow-JSON passes SKIPPED/);

  const full = run(fixture("claims-clean"));
  assert.equal(full.code, 1);
  assert.match(full.out, /MANIFEST_MISSING/);
});

test("a folder with no sidecars says the claims checks were no-ops", () => {
  const r = run(fixture("valid"));
  assert.match(r.err, /0 claims sidecars found/);
});

test("coverage is reported, so a check that inspected nothing cannot hide", () => {
  const clean = run(fixture("valid-v2"));
  assert.match(clean.err, /validate coverage:/);
  assert.match(clean.err, /inspected \d+ workflow steps/);
  assert.match(clean.err, /not implemented here:/);

  // A folder with no captures must SAY the workflow checks were no-ops.
  const noWf = run(fixture("valid"));
  assert.match(noWf.err, /0 workflow captures found/);
});

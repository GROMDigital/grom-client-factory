import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(here, "..", "validate.mjs");
const fixer = path.join(here, "..", "conformance_fix.mjs");
const fixture = (name) => path.join(here, "fixtures", name);

function run(folder, ...flags) {
  const r = spawnSync("node", [validator, folder, ...flags], { encoding: "utf8" });
  // stdout carries the machine-readable violations; stderr carries the coverage report.
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function runFixer(folder, ...flags) {
  const r = spawnSync("node", [fixer, folder, ...flags], { encoding: "utf8" });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// The fixer mutates, so it never runs against the fixture itself.
function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grom-fix-"));
  fs.cpSync(fixture(name), dir, { recursive: true });
  return dir;
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
    ["EM_DASH", path.join("design", "08-nurture-and-longform-copy.md")],
    ["MALFORMED_FILL_TOKEN", path.join("design", "01-brief.md")],
    ["PLATFORM_NAME_IN_LP", path.join("lp", "index.html")],
    ["BAD_LP_EVENT", path.join("lp", "index.html")],
  ];
  for (const [rule, file] of expected) {
    const pat = new RegExp("^" + rule + "\\t" + file.replace(/[.\\]/g, "\\$&") + "\\t", "m");
    assert.match(r.out, pat, `expected ${rule} on ${file} in output:\n${r.out}`);
  }
});

test("guardrail 2 is scoped: an em dash in internal analysis prose is not a violation", () => {
  // fixtures/invalid/design/01-brief.md contains two em dashes. It is a
  // research brief, which no lead, caller or client ever sees, so the rule
  // must not fire on it. The same fixture's nurture copy doc still fails,
  // which the rule-coverage test above asserts.
  const r = run(fixture("invalid"));
  assert.doesNotMatch(
    r.out,
    new RegExp("^EM_DASH\\t" + path.join("design", "01-brief.md").replace(/[.\\]/g, "\\$&"), "m"),
    `internal brief should be exempt from EM_DASH, got:\n${r.out}`,
  );
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

// --- what the 2026-07-28 run proved was broken ---------------------------
// All four of the tests below reproduce a defect that cost real work: the
// closing validate of that build FAILED, and every one of its nine violations
// was the validator's own fault rather than the build's.

test("documents at the client-folder root are scanned, and their sidecars live in design/claims", () => {
  // go-live-checklist.md and post-launch-onboarding.md sit at the client root by
  // registry decree. The validator walked design/, lp/ and build/ only, so those
  // two were never scanned and their sidecars looked orphaned BY CONSTRUCTION.
  // Three fixer agents believed that and deleted five sidecars.
  const r = run(fixture("root-and-pattern"), "--conformance");
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /CLAIMS_(ORPHAN_SIDECAR|SIDECAR_MISSING)/, r.out);
});

test("prose describing the token pattern is not a malformed token", () => {
  // {{FILL_*}} and {{FILL_...}} in the fill guide's own explanatory text flagged
  // on three consecutive runs. No fixer could ever clear it, so files were
  // "fixed" twice and the violation survived both times.
  const r = run(fixture("root-and-pattern"), "--conformance");
  assert.doesNotMatch(r.out, /MALFORMED_FILL_TOKEN/, r.out);

  // The real rule still bites: a lower-case token is still malformed.
  const real = run(fixture("invalid"));
  assert.match(real.out, /^MALFORMED_FILL_TOKEN\t/m);
});

test("a pattern literal does not hide a real malformed token later on the same line", () => {
  // The exemption was matched non-globally, so the FIRST match won the line. The
  // one file guaranteed to put a literal and a real token on one line is the
  // fill guide's own explanatory text, which is the file the exemption exists
  // for, so the check could not fire exactly where it mattered.
  const r = run(fixture("mixed-token-line"), "--conformance");
  assert.match(r.out, /^MALFORMED_FILL_TOKEN\tdesign\/mixed-line\.md\t.*FILL_lower_case/m, r.out);
  // the literal on the same line is still not itself a violation
  assert.doesNotMatch(r.out, /MALFORMED_FILL_TOKEN.*\{\{FILL_\*\}\}/, r.out);
});

test("--docs catches a document that was promised and never written", () => {
  // The only check in the factory that can detect an agent dying mid-write,
  // because every other check reads what WAS written.
  const r = run(fixture("valid"), `--docs=design/01-brief.md,design/never-written.md`);
  assert.equal(r.code, 1);
  assert.match(r.out, /^DOC_MISSING\tdesign\/never-written\.md\t/m, r.out);
  assert.doesNotMatch(r.out, /^DOC_MISSING\tdesign\/01-brief\.md/m);
  assert.match(r.err, /inspected \d+ promised documents/);
});

test("--docs catches a document that was started and abandoned", () => {
  const dir = scratch("valid");
  fs.writeFileSync(path.join(dir, "design", "stub.md"), "# Workflows\n\nTODO\n");
  const r = run(dir, `--docs=design/stub.md`);
  assert.equal(r.code, 1);
  assert.match(r.out, /^DOC_STUB\tdesign\/stub\.md\t.*bytes/m, r.out);
});

test("per-workflow docs under design/workflows/ are treated as customer copy", () => {
  // 07-journey-and-workflows.md was split into one document per workflow so the
  // audit fixer loads a small file instead of 73KB. Those files carry the real
  // SMS and email copy, and their basenames are per-client slugs no name
  // pattern can match, so the rule is the directory.
  const r = run(fixture("workflow-split"), "--conformance");
  assert.equal(r.code, 1);
  assert.match(r.out, /^EM_DASH\tdesign\/workflows\/01-meta-lead-intake\.md\t/m, r.out);
  // and the exemption still holds for internal analysis prose beside it
  assert.doesNotMatch(r.out, /^EM_DASH\tdesign\/business-and-offer-brief\.md/m, r.out);
});

// --- the code repair that replaced 24 fixer agents ------------------------

test("code repair clears every mechanical claims defect", () => {
  const dir = scratch("fixer-repair");
  const fix = runFixer(dir);
  assert.equal(fix.code, 0, fix.out);

  // numbering drift is a rename, not an orphan
  assert.match(fix.out, /^RENAMED_SIDECAR\t.*thing\.json\t-> 01-thing\.json/m, fix.out);
  assert.ok(fs.existsSync(path.join(dir, "build/2026-07-27/claims/01-thing.json")));
  // a doc with tokens and no sidecar gets one
  assert.match(fix.out, /^CREATED_SIDECAR\t.*02-other\.json/m, fix.out);
  // a token the doc does not contain stops being claimed
  assert.match(fix.out, /^DROPPED_PHANTOMS\t.*FILL_GHOST_TOKEN/m, fix.out);
  // an undeclared token gets declared
  assert.match(fix.out, /^DECLARED_TOKENS\t.*FILL_ADDRESS/m, fix.out);

  const after = run(dir, "--conformance");
  const rules = after.out.split("\n").map((l) => l.split("\t")[0]);
  assert.deepEqual(
    [...new Set(rules)].filter((r) => r.startsWith("CLAIMS_")),
    ["CLAIMS_ORPHAN_SIDECAR"],
    `only the unresolvable orphan should survive:\n${after.out}`,
  );
});

test("code repair NEVER deletes a file it cannot resolve", () => {
  // This is the whole reason the repair moved out of an agent. On 2026-07-28
  // three fixer agents hit a rule their prompt did not cover, improvised, and
  // deleted five sidecars carrying 25 fill tokens between them.
  const dir = scratch("fixer-repair");
  const before = fs.readdirSync(path.join(dir, "build/2026-07-27/claims")).length;
  const fix = runFixer(dir);
  const orphan = path.join(dir, "build/2026-07-27/claims/zzz-no-such-doc.json");

  assert.ok(fs.existsSync(orphan), "an unresolvable sidecar must be left on disk, never removed");
  assert.match(fix.out, /^UNFIXABLE\t.*zzz-no-such-doc\.json\t.*NOT deleted/m, fix.out);
  assert.ok(fs.readdirSync(path.join(dir, "build/2026-07-27/claims")).length >= before,
    "the repair must never reduce the number of sidecars");
});

test("--dry-run reports the same actions and writes nothing", () => {
  const dir = scratch("fixer-repair");
  const snapshot = () => fs.readdirSync(path.join(dir, "build/2026-07-27/claims")).sort().join(",");
  const before = snapshot();
  const dry = runFixer(dir, "--dry-run");
  assert.match(dry.err, /dry run, nothing written/);
  assert.equal(snapshot(), before, "dry run must not touch the filesystem");
  // and it must not double-report a rename target as also needing creation
  assert.doesNotMatch(dry.out, /^CREATED_SIDECAR\t.*01-thing\.json/m, dry.out);
});

// --- cross-document name reconciliation, in code -------------------------

test("--reconcile finds an undefined reference and a spelling collision, with lines", () => {
  const r = run(fixture("reconcile"), "--conformance", "--reconcile");
  assert.match(r.out, /^RECONCILE_UNDEFINED_REFERENCE\tdesign\/07-workflows\.md:4\t.*Booking Confirmed/m, r.out);
  assert.match(r.out, /^RECONCILE_NAME_COLLISION_CANDIDATE\tdesign\/07-workflows\.md:3\t.*Deposit Paid.*deposit-paid/m, r.out);
  // the line is the point: the agent could never produce one cheaply
  assert.match(r.out, /anchor: /, r.out);
});

test("--reconcile candidates never fail the build", () => {
  // Whether two similar names mean one thing is a judgement no script can make,
  // and failing a build on a guess is worse than not checking. Candidates are
  // reported below a marker and leave the exit code alone.
  const r = run(fixture("reconcile"), "--conformance", "--reconcile");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^validate: PASS/m);
  assert.match(r.out, /RECONCILE CANDIDATES \(judgement required, not violations/);
});

test("--reconcile is off unless asked for", () => {
  const r = run(fixture("reconcile"), "--conformance");
  assert.doesNotMatch(r.out, /RECONCILE/, r.out);
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

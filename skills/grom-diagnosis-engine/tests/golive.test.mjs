import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "golive_check.mjs");
const fixture = (n) => path.join(here, "fixtures", n);

function run(file) {
  try { return { code: 0, out: execFileSync("node", [script, file], { encoding: "utf8" }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
}

test("ready manifest passes", () => {
  const r = run(fixture("manifest-golive-ready.json"));
  assert.equal(r.code, 0, r.out);
});

test("gapped manifest fails naming each unfilled execution-discovered field", () => {
  const r = run(fixture("manifest-golive-gaps.json"));
  assert.equal(r.code, 1);
  assert.match(r.out, /GOLIVE_GAP\tphone\.tracked_number\t/);
  assert.match(r.out, /GOLIVE_GAP\ttracking\.clarity_project_id\t/);
  assert.match(r.out, /GOLIVE_GAP\tids_harvested\t/);
  assert.ok(!r.out.includes("tracking.meta_pixel_id"), "filled field wrongly flagged");
});

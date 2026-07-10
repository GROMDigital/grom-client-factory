import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(here, "..", "validate.mjs");
const fixture = (name) => path.join(here, "fixtures", name);

function run(folder) {
  try {
    const out = execFileSync("node", [validator, folder], { encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
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

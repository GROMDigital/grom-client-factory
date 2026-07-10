import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "prompt_lint.mjs");
const fixture = (n) => path.join(here, "fixtures", n);

function run(dir) {
  try { return { code: 0, out: execFileSync("node", [script, dir], { encoding: "utf8" }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
}

test("good fixture passes", () => {
  const r = run(fixture("lint-good"));
  assert.equal(r.code, 0, r.out);
});

test("bad fixture fails naming each problem", () => {
  const r = run(fixture("lint-bad"));
  assert.equal(r.code, 1);
  assert.match(r.out, /LINT\tbeta-role\tmissing prompt file/);
  assert.match(r.out, /LINT\talpha-role\tmissing section ## Claims/);
  assert.match(r.out, /LINT\talpha-role\tcontains em dash/);
  assert.match(r.out, /LINT\tgamma-orphan\torphan prompt file/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "sanitize_capture.mjs");
const fixture = (n) => path.join(here, "fixtures", n);

function run(args) {
  try { return { code: 0, out: execFileSync("node", [script, ...args], { encoding: "utf8" }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
}

test("dirty capture: every secret kind is redacted, structure preserved", () => {
  const out = path.join(os.tmpdir(), `sanitized-${process.pid}.json`);
  const r = run([fixture("capture-dirty.json"), out]);
  assert.equal(r.code, 0, r.out);
  const s = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(s.headers.Authorization, "<REDACTED:bearer>");
  assert.equal(s.steps[0].config.accessToken, "<REDACTED:meta-capi>");
  assert.equal(s.steps[1].config.webhook.jwt, "<REDACTED:jwt>");
  assert.equal(s.meta.api_key, "<REDACTED:secret-key>");
  assert.equal(s.headers.Cookie, "<REDACTED:cookie>");
  assert.equal(s.name, "05 Deposit Chase");
  assert.equal(s.steps.length, 2);
  for (const kind of ["bearer", "meta-capi", "jwt", "secret-key", "cookie"]) {
    assert.match(r.out, new RegExp(`REDACTED\\t.*\\t${kind}`), `expected ${kind} line:\n${r.out}`);
  }
});

test("clean capture: byte-equivalent output, no REDACTED lines", () => {
  const out = path.join(os.tmpdir(), `clean-${process.pid}.json`);
  const r = run([fixture("capture-clean.json"), out]);
  assert.equal(r.code, 0);
  assert.ok(!r.out.includes("REDACTED"));
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), JSON.parse(fs.readFileSync(fixture("capture-clean.json"), "utf8")));
});

test("--check mode: exit 1 on dirty, 0 on clean", () => {
  assert.equal(run(["--check", fixture("capture-dirty.json")]).code, 1);
  assert.equal(run(["--check", fixture("capture-clean.json")]).code, 0);
});

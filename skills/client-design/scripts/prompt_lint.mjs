#!/usr/bin/env node
// Roster/prompt consistency floor for client-design. Usage: prompt_lint.mjs <client-design-skill-dir>
// Exit 0 all good / 1 problems (LINT\trole\tproblem lines) / 2 usage.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, "roster.json"))) {
  console.error("usage: prompt_lint.mjs <client-design-skill-dir (containing roster.json + prompts/)>");
  process.exit(2);
}
const roster = JSON.parse(fs.readFileSync(path.join(dir, "roster.json"), "utf8"));
const promptsDir = path.join(dir, "prompts");
const REQUIRED = ["# Role", "## Inputs", "## Deliverable", "## Claims", "## Boundaries"];
const problems = [];

for (const role of roster.roles) {
  const p = path.join(promptsDir, `${role.id}.md`);
  if (!fs.existsSync(p)) { problems.push(`LINT\t${role.id}\tmissing prompt file`); continue; }
  const text = fs.readFileSync(p, "utf8");
  for (const section of REQUIRED) {
    const re = new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m");
    if (!re.test(text)) problems.push(`LINT\t${role.id}\tmissing section ${section}`);
  }
  if (text.includes("—")) problems.push(`LINT\t${role.id}\tcontains em dash`);
}

const rosterIds = new Set(roster.roles.map((r) => r.id));
if (fs.existsSync(promptsDir)) {
  for (const f of fs.readdirSync(promptsDir)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const id = f.replace(/\.md$/, "");
    if (!rosterIds.has(id)) problems.push(`LINT\t${id}\torphan prompt file`);
  }
}

if (problems.length) { console.log(problems.join("\n")); process.exit(1); }
console.log("prompt_lint: PASS");

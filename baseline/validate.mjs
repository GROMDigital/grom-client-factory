#!/usr/bin/env node
// Mechanical Tier-1 floor for a Grom client folder. Usage: node validate.mjs <client-folder>
// Prints one violation per line on stdout: RULE\tfile\tdetail. Exit 0 pass / 1 violations.
// Prints a COVERAGE report on stderr: what each check actually inspected.
//
// Coverage is not decoration. This estate's recurring failure is a checker that
// returns "pass, issues: []" on a build the builder shows 7 errors for. A check
// that inspected 0 nodes has proven nothing, and says so here rather than
// passing quietly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTHORED_EXT, bareToken, claimsDirs as claimsDirsFor, docTokenIndex,
  isClaimsPath, malformedTokenOn, scannedFiles,
} from "./lib/docscan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "client-manifest.schema.json"), "utf8"));

// ---- contracts read FROM the schema, so the schema stays the single source ----
const CANONICAL = schema.properties.stage_map.additionalProperties.enum.filter((v) => v !== null);
const STANDARD_STAGES = schema["x-standard-stages"];
const STANDARD_LOST_REASONS = schema["x-standard-lost-reasons"];
const RESERVED_WF = new RegExp(Object.keys(schema.properties.base_workflows.patternProperties)[0]);
const versionBranch = (pred) => schema.allOf?.find(pred)?.then?.required ?? [];
const V1_REQUIRED = versionBranch((a) => a.if?.properties?.manifest_version?.const === 1);
const V2_REQUIRED = versionBranch((a) => (a.if?.properties?.manifest_version?.minimum ?? 0) >= 2);

const LP_EVENTS = new Set(["lp_view", "booking_started", "booking_cta_clicked", "booking_submitted", "offer_viewed"]);
const PLATFORM = /gohighlevel|highlevel(?!\.stoplight)|(?<![a-z])ghl(?![a-z-])/i;

// Standard Build workflow presence. Gaps are information, absence of an always-on one is not.
const ALWAYS_ON = ["01", "02", "03", "06", "07", "08", "09", "10", "11", "12", "13", "14"];
const CALENDAR_WORKFLOWS = ["04", "05"];   // suppressed when the diary lives elsewhere
const EXTERNAL_WORKFLOWS = ["25"];         // required only when it does
const REGRESSING_WORKFLOWS = new Set(["01", "03", "04", "07"]); // base-workflows.md 3.2 rule 3
const REQUIRED_PER_CYCLE_FIELDS = ["treatment_interest", "cycle_index", "amount_paid"];

// Lead-facing sends, from the engine catalog. Internal notifications and Slack are
// deliberately absent: stopOnResponse protects the LEAD from being talked over.
const SEND_TYPES = new Set([
  "sms", "email", "call", "voicemail", "manual-sms", "manual-call", "review_request",
  "send_whatsapp_message", "send_whatsapp_flow", "whatsapp_v2", "send_smart_message",
  "voice_ai_outbound_call", "imessage_a", "rcs_interactive_message",
]);
const CREATE_OPP_TYPES = new Set(["create_opportunity", "internal_create_opportunity"]);
const UPDATE_OPP_TYPES = new Set(["update_opportunity", "internal_update_opportunity"]);

// --conformance runs ONLY the text and claims passes. It exists so the workflow
// can check guardrail conformance mid-build, before a manifest exists, without
// drowning the result in MANIFEST_MISSING. Agents used to run these checks on
// themselves with grep, at peak context, which was measured as roughly a
// quarter of every run's model calls. The rules did not move; the checking did.
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const CONFORMANCE_ONLY = flags.has("--conformance");

// --docs=<comma separated client-relative paths> asserts that documents the
// registry's doc index promised actually exist. The factory had no notion of
// "something that should exist does not": workflow-designer died mid-write on
// 2026-07-28, wrote nothing, and the copywriter that depends on its document
// ran anyway and found nothing to read. Nothing noticed. This is the notice.
const EXPECTED_DOCS = [...flags]
  .filter((f) => f.startsWith("--docs="))
  .flatMap((f) => f.slice("--docs=".length).split(","))
  .map((s) => s.trim())
  .filter(Boolean);
// Under this many bytes a design document is a stub, not a deliverable. The
// real ones run to tens of KB; the failure mode being caught is a header and
// nothing under it, written by an agent that ran out of room or gave up.
const DOC_STUB_BYTES = 400;

const root = positional[0];
if (!root || !fs.existsSync(root)) {
  console.error("usage: validate.mjs <client-folder> [--conformance] [--docs=a.md,b.md]");
  process.exit(2);
}
const violations = [];
const v = (rule, file, detail) => violations.push(`${rule}\t${file}\t${detail}`);

// Coverage counters. Every check registers what it looked at, even when it found nothing.
const cov = {};
const saw = (check, n = 1) => { cov[check] = (cov[check] ?? 0) + n; };
const NOT_IMPLEMENTED = [
  "per-STEP stopOnResponse (only the workflow-level flag is in the export)",
  "correctness of an appointment-wait past-anchor guard (absence is detected, correctness is not)",
  "knowledgeBaseIds / calendarIds / autoPilotMaxMessages (agent config is not in a workflow export)",
  "that a per_cycle_field's opportunity_field_id really exists on the account (needs a live read)",
];

// ---------------------------------------------------------------- 1. Manifest
let manifest = null;
const manifestPath = path.join(root, "client-manifest.json");
if (CONFORMANCE_ONLY) {
  // deliberately not read; the manifest and workflow passes are out of scope here
} else if (!fs.existsSync(manifestPath)) {
  v("MANIFEST_MISSING", "client-manifest.json", "no manifest at client-folder root");
} else {
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch (e) { v("MANIFEST_INVALID_JSON", "client-manifest.json", e.message); }
}

const MF = "client-manifest.json";
if (manifest) {
  const m = manifest;
  const version = m.manifest_version ?? 1;
  saw("manifest");

  for (const req of schema.required) if (!(req in m)) v("MANIFEST_REQUIRED_FIELD", MF, `missing ${req}`);

  // The version split lives in the schema as if/then, which this validator cannot
  // evaluate, so it is applied explicitly here. Without this a v2 manifest with no
  // pipelines passes, which is the whole defect v2 exists to fix.
  const conditional = version >= 2 ? V2_REQUIRED : V1_REQUIRED;
  for (const req of conditional) {
    if (!(req in m)) v("MANIFEST_REQUIRED_FIELD", MF, `missing ${req} (required at manifest_version ${version})`);
  }

  if (version === 1) {
    for (const [stage, step] of Object.entries(m.stage_map ?? {})) {
      saw("stage_map entries");
      if (step !== null && !CANONICAL.includes(step)) v("MANIFEST_BAD_CANONICAL_STEP", MF, `${stage} -> ${step}`);
    }
  }

  if (version >= 2) {
    const external = m.booking?.model === "external";

    // pipelines[]
    const keys = new Set(), slugs = new Set();
    for (const p of m.pipelines ?? []) {
      saw("pipelines");
      if (keys.has(p.key)) v("MANIFEST_DUPLICATE_PIPELINE_KEY", MF, `pipeline key ${p.key} used twice`);
      keys.add(p.key);
      if (p.funnel_slug != null) {
        if (slugs.has(p.funnel_slug)) v("MANIFEST_DUPLICATE_FUNNEL_SLUG", MF, `funnel_slug ${p.funnel_slug} used twice`);
        slugs.add(p.funnel_slug);
      }
      const present = Object.keys(p.stage_ids ?? {});
      for (const s of STANDARD_STAGES) {
        if (!present.includes(s)) v("MANIFEST_MISSING_STAGE", MF, `pipeline ${p.key}: no "${s}" stage`);
      }
      // Extra keys are legal ONLY after Done. We cannot see board order here, so the
      // rule enforced is the decidable half: the eight must all be present.
      if (p.offer_price === 0) {
        v("MANIFEST_ZERO_OFFER_PRICE", MF,
          `pipeline ${p.key}: offer_price 0 makes the pipeline look empty and early drop-off look costless`);
      }
    }

    // base_workflows
    const bw = m.base_workflows ?? {};
    for (const num of Object.keys(bw)) {
      saw("base_workflows");
      if (!RESERVED_WF.test(num)) v("MANIFEST_BAD_WORKFLOW_NUMBER", MF, `${num} is not a reserved base number`);
    }
    for (const num of ALWAYS_ON) {
      if (!(num in bw)) v("MANIFEST_MISSING_BASE_WORKFLOW", MF, `${num} is always-on and is absent`);
    }
    for (const num of CALENDAR_WORKFLOWS) {
      if (external && num in bw) {
        v("MANIFEST_BOOKING_MODEL_CONFLICT", MF, `${num} must not be built when booking.model is external`);
      }
      if (!external && !(num in bw)) {
        v("MANIFEST_MISSING_BASE_WORKFLOW", MF, `${num} is required unless booking.model is external`);
      }
    }
    for (const num of EXTERNAL_WORKFLOWS) {
      if (external && !(num in bw)) {
        v("MANIFEST_MISSING_BASE_WORKFLOW", MF, `${num} is required when booking.model is external, or the client has no tail`);
      }
    }

    // lost reasons
    for (const r of STANDARD_LOST_REASONS) {
      saw("lost_reasons");
      if (!(r in (m.lost_reason_ids ?? {}))) v("MANIFEST_MISSING_LOST_REASON", MF, `no entry for "${r}"`);
    }

    // per-cycle fields. Replaces the undecidable prose rule with a declared list.
    const declared = new Set((m.per_cycle_fields ?? []).map((f) => f.key));
    saw("per_cycle_fields", declared.size);
    for (const f of REQUIRED_PER_CYCLE_FIELDS) {
      if (!declared.has(f)) v("MANIFEST_MISSING_PER_CYCLE_FIELD", MF, `${f} is standard and is not declared`);
    }

    // knobs
    const k = m.knobs ?? {};
    saw("knobs");
    if (typeof k.decay_days === "number" && typeof k.ladder_length_days === "number"
        && !(k.decay_days > k.ladder_length_days)) {
      v("MANIFEST_KNOB_RELATION", MF,
        `decay_days (${k.decay_days}) must exceed ladder_length_days (${k.ladder_length_days}), or 10 chases a lead 01 is still working`);
    }
  }
}

// -------------------------------------------------- 2. Workflow JSON pass
// Layout written by get-ghl-workflow-json:
//   workflow-json/{locationId}/{workflowId}/{YYYY-MM-DD-HHMM}/workflow.json (+ trigger.json)
const dirs = (p) => fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

const wfNumberById = new Map();
for (const [num, e] of Object.entries(manifest?.base_workflows ?? {})) {
  if (e?.ghl_workflow_id) wfNumberById.set(e.ghl_workflow_id, num);
}

const captures = [];
const wfRoot = path.join(root, "workflow-json");
for (const loc of (CONFORMANCE_ONLY ? [] : dirs(wfRoot))) {
  for (const wid of dirs(path.join(wfRoot, loc))) {
    const stamps = dirs(path.join(wfRoot, loc, wid)).sort();
    if (!stamps.length) continue;
    const dir = path.join(wfRoot, loc, wid, stamps[stamps.length - 1]); // latest capture only
    const wfFile = path.join(dir, "workflow.json");
    if (fs.existsSync(wfFile)) captures.push({ wid, dir, wfFile });
  }
}

for (const { wid, dir, wfFile } of captures) {
  const relWf = path.relative(root, wfFile);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(wfFile, "utf8")); }
  catch (e) { v("WF_INVALID_JSON", relWf, e.message); continue; }
  saw("workflows");

  const num = wfNumberById.get(wid) ?? (String(j.name ?? "").match(/^(\d{2})\b/)?.[1] ?? null);
  const label = num ? `${num} (${j.name})` : String(j.name ?? wid);
  const steps = j.workflowData?.templates ?? [];
  saw("workflow steps", steps.length);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const cif = (s) => s.attributes?.__customInputFields__ ?? [];
  const hasField = (s, name) => cif(s).some((f) => f.filterField === name);

  // --- the deployment gate. The single most important pair: a build whose
  // workflows are all 2-byte-trigger drafts would otherwise pass clean.
  saw("deployment gate");
  if (j.status !== "published") v("WF_NOT_PUBLISHED", relWf, `${label}: status is "${j.status}"`);
  const trigFile = path.join(dir, "trigger.json");
  if (!fs.existsSync(trigFile)) {
    v("WF_TRIGGER_FILE_MISSING", relWf, `${label}: no trigger.json beside it, so the gate cannot be checked`);
  } else {
    let t = null;
    try { t = JSON.parse(fs.readFileSync(trigFile, "utf8")); } catch { t = null; }
    const empty = t == null || (Array.isArray(t) ? t.length === 0 : Object.keys(t).length === 0);
    if (empty) v("WF_TRIGGER_FILE_EMPTY", relWf, `${label}: trigger file is empty, so nothing enrols`);
  }

  // --- message hygiene
  const sends = steps.filter((s) => SEND_TYPES.has(s.type));
  if (sends.length) {
    saw("stopOnResponse");
    if (j.stopOnResponse !== true) {
      v("WF_STOP_ON_RESPONSE_OFF", relWf, `${label}: ${sends.length} lead-facing send step(s) and stopOnResponse is not true`);
    }
  }

  for (const s of steps) {
    // --- monetaryValue three-part shape
    const mv = cif(s).find((f) => f.filterField === "monetaryValue");
    if (mv) {
      saw("monetaryValue writes");
      const ok = typeof mv.value === "number" && mv.valueFieldType === "numerical" && mv.dataType === "NUMERICAL";
      if (!ok) {
        v("WF_MONETARY_VALUE_SHAPE", relWf,
          `${label} / ${s.name}: needs value as a NUMBER + valueFieldType "numerical" + dataType "NUMERICAL", got ` +
          `${JSON.stringify(mv.value)} / ${JSON.stringify(mv.valueFieldType)} / ${JSON.stringify(mv.dataType)}`);
      }
    }

    // --- a stage always needs its pipeline, or the node renders DISABLED
    if (CREATE_OPP_TYPES.has(s.type) || UPDATE_OPP_TYPES.has(s.type)) {
      if (hasField(s, "pipelineStageId") && !s.attributes?.pipelineId && !hasField(s, "pipelineId")) {
        v("WF_STAGE_WITHOUT_PIPELINE", relWf,
          `${label} / ${s.name}: sets a stage with no pipeline, which renders the node DISABLED and it never runs`);
      }
    }

    // --- allowBackward on stage writes in the workflows that regress
    if (UPDATE_OPP_TYPES.has(s.type) && hasField(s, "pipelineStageId")) {
      saw("stage writes");
      if (num && REGRESSING_WORKFLOWS.has(num) && s.attributes?.allowBackward !== true) {
        v("WF_MISSING_ALLOW_BACKWARD", relWf,
          `${label} / ${s.name}: ${num} can move a card backwards and allowBackward is not true, so the move silently no-ops`);
      }
    }

    // --- finders
    if (s.type === "find_opportunity") {
      saw("finders");
      const filters = cif(s);
      if (!filters.length) {
        v("WF_FINDER_NO_FILTER", relWf, `${label} / ${s.name}: no filters, so it matches an arbitrary opportunity`);
      }
      const wrong = filters.filter((f) => f.filterField !== "pipeline_id");
      if (wrong.length) {
        v("WF_FINDER_NOT_PIPELINE_ONLY", relWf,
          `${label} / ${s.name}: filters on ${wrong.map((f) => f.filterField).join(", ")}; a stage-filtered finder returns Not Found for a card at another stage and manufactures a duplicate`);
      }

      // --- every not-found branch creates the card and then jumps back
      const notFound = (s.attributes?.transitions ?? []).filter((t) => /not\s*found/i.test(t.name ?? ""));
      for (const t of notFound) {
        saw("not-found branches");
        const seen = new Set();
        const stack = [t.id];
        let created = false, jumped = false;
        while (stack.length && seen.size < 500) {
          const id = stack.pop();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const node = byId.get(id);
          if (!node) continue;
          if (CREATE_OPP_TYPES.has(node.type)) created = true;
          if (node.type === "goto") jumped = true;
          const nx = node.next;
          if (Array.isArray(nx)) stack.push(...nx); else if (nx) stack.push(nx);
        }
        if (!created || !jumped) {
          v("WF_NOT_FOUND_DEAD_END", relWf,
            `${label} / branch "${t.name}": ${created ? "creates the card but never jumps back" : "never creates the card"}, so the rest of the workflow runs against nothing`);
        }
      }
    }

    // --- goto targets must resolve
    if (s.type === "goto") {
      saw("gotos");
      const target = s.attributes?.targetNodeId;
      if (!target || !byId.has(target)) {
        v("WF_GOTO_UNRESOLVED", relWf, `${label} / ${s.name}: targetNodeId ${JSON.stringify(target)} is not a step in this workflow`);
      }
    }

    // --- appointment-anchored waits need a past-anchor guard
    if (s.type === "wait") {
      const a = s.attributes ?? {};
      const anchored = "appointmentStartAfter" in a || "appointmentCondition" in a;
      if (anchored) {
        saw("appointment-anchored waits");
        let cur = s.parentKey, guard = false, hops = 0;
        while (cur && hops++ < 200) {
          const p = byId.get(cur);
          if (!p) break;
          if (p.type === "if_else") { guard = true; break; }
          cur = p.parentKey;
        }
        if (!guard) {
          v("WF_APPT_WAIT_NO_PAST_BRANCH", relWf,
            `${label} / ${s.name}: appointment-anchored wait with no if_else anywhere above it; a wait whose moment has passed fires immediately and the whole ladder burns at once`);
        }
      }
    }
  }
}

// ------------------------------------------------------------- 3. Text scans
const rel = (f) => path.relative(root, f);

// Tokens actually present in each authored doc, keyed by basename without
// extension, which is also the claims sidecar's basename. Claims files are
// excluded: a sidecar listing a token is a declaration, not an occurrence.
// Scanning (and the claims-directory set below) comes from lib/docscan.mjs so
// the repair tool cannot ever disagree with this file about what exists.
const docIndex = docTokenIndex(root);
const docTokens = new Map([...docIndex].map(([k, e]) => [k, e.tokens]));
const isClaims = (f) => isClaimsPath(root, f);

// Guardrail 2 is scoped to what a lead, caller or client can see, plus the
// instruction text of the live AI agents so they never emit an em dash. It is
// NOT a house style for internal analysis prose. Copy sits inline with the
// designer's own reasoning inside the copy-bearing docs, with no marker
// separating the two, so those files are checked whole: over-policing inside a
// copy doc is the safe side to be wrong on. Everything else (research briefs,
// the architecture registry, pipeline/fields/tracking docs, the fill guide,
// the go-live checklist) is exempt.
const COPY_BEARING = /(brand-voice|nurture|longform|conversation-ai|voice-ai|journey-and-workflows|landing-page|system-guide)/i;
const isCustomerFacing = (f) => {
  const r = rel(f);
  if (r.startsWith("lp" + path.sep)) return true;
  if (isClaims(f)) return false;
  if (r.split(path.sep)[0] === "build") return false;
  return COPY_BEARING.test(path.basename(f));
};

for (const f of scannedFiles(root)) {
  if (!/\.(md|html|json|txt)$/i.test(f)) continue;
  const text = fs.readFileSync(f, "utf8");
  const lines = text.split("\n");
  saw("scanned files");
  const customerFacing = isCustomerFacing(f);
  if (customerFacing) saw("customer-facing files checked for em dashes");
  lines.forEach((line, i) => {
    if (customerFacing && line.includes("\u2014")) v("EM_DASH", rel(f), `line ${i + 1}`);
    const badToken = malformedTokenOn(line);
    if (badToken) v("MALFORMED_FILL_TOKEN", rel(f), `line ${i + 1}: ${badToken}`);
  });
  if (rel(f).startsWith("lp" + path.sep)) {
    lines.forEach((line, i) => {
      if (PLATFORM.test(line)) v("PLATFORM_NAME_IN_LP", rel(f), `line ${i + 1}`);
      for (const call of line.matchAll(/gromCapture\(\s*['"]([^'"]+)['"]/g))
        if (!LP_EVENTS.has(call[1])) v("BAD_LP_EVENT", rel(f), `line ${i + 1}: ${call[1]}`);
    });
  }
}

// -------------------------------------------------- 3b. Claims sidecar pass
// Guardrail 3: every token an agent introduces must appear in its claims
// sidecar. Agents were each enforcing this on themselves by grepping their own
// output and hand-validating their own JSON, which cost model calls at peak
// context and could be forgotten. Here it always runs.
const claimsDirs = claimsDirsFor(root);

// Sidecars are written with and without braces depending on the agent, so both
// forms normalise to the bare name before comparison.
const bare = bareToken;

for (const cdir of claimsDirs) {
  for (const file of fs.readdirSync(cdir).filter((f) => f.endsWith(".json"))) {
    const full = path.join(cdir, file);
    const key = file.replace(/\.json$/, "");
    saw("claims sidecars");
    let sidecar = null;
    try { sidecar = JSON.parse(fs.readFileSync(full, "utf8")); }
    catch (e) { v("CLAIMS_INVALID_JSON", rel(full), e.message); continue; }

    const declared = new Set();
    for (const side of ["defines", "references"]) {
      for (const t of sidecar?.[side]?.fill_tokens ?? []) declared.add(bare(t));
    }

    const inDoc = docTokens.get(key);
    if (!inDoc) {
      v("CLAIMS_ORPHAN_SIDECAR", rel(full),
        `no authored doc named ${key}.md or ${key}.html, so this sidecar guards nothing`);
      continue;
    }
    saw("claimed fill tokens", declared.size);

    for (const t of inDoc) {
      if (!declared.has(t)) {
        v("CLAIMS_TOKEN_UNDECLARED", rel(full),
          `{{${t}}} appears in ${key} but is not in the sidecar, so the fill guide will never ask the client for it`);
      }
    }
    for (const t of declared) {
      if (!inDoc.has(t)) {
        v("CLAIMS_TOKEN_PHANTOM", rel(full),
          `sidecar claims {{${t}}} but it appears nowhere in ${key}, so the client gets asked a question nothing consumes`);
      }
    }
  }
}

// A doc carrying tokens with no sidecar at all is the same defect as an
// undeclared token, one level up.
// system-guide.html and anything else rendered to the client-folder root as
// HTML is DERIVED: every token in it is a copy of a token some design doc
// already defines and already declares. Demanding its own sidecar would ask the
// client the same 46 questions twice.
const isDerivedRender = (entry) =>
  entry.files.every((f) => path.resolve(path.dirname(f)) === path.resolve(root) && /\.html$/i.test(f));

for (const [key, entry] of docIndex) {
  const tokens = entry.tokens;
  if (!tokens.size || isDerivedRender(entry)) continue;
  const hasSidecar = claimsDirs.some((d) => fs.existsSync(path.join(d, `${key}.json`)));
  if (!hasSidecar && claimsDirs.length) {
    v("CLAIMS_SIDECAR_MISSING", key,
      `${tokens.size} fill token(s) and no claims/${key}.json, so none of them reach the fill guide`);
  }
}

// ------------------------------------------- 3c. Promised documents exist
// The doc index is a promise. This is the only check in the factory that can
// catch an agent dying mid-write, because every other check reads what WAS
// written and a dead agent writes nothing at all.
for (const d of EXPECTED_DOCS) {
  if (!AUTHORED_EXT.test(d)) continue; // doc-index rows like "voice AI | Not this client"
  saw("promised documents");
  const full = path.join(root, d);
  if (!fs.existsSync(full)) {
    v("DOC_MISSING", d, "the registry doc index promises this document and it is not on disk");
    continue;
  }
  const size = fs.statSync(full).size;
  if (size < DOC_STUB_BYTES) {
    v("DOC_STUB", d, `only ${size} bytes, so it was started and not finished`);
  }
}

// ------------------------------------------------------------- 4. Report
const coverageLines = [
  CONFORMANCE_ONLY ? "validate coverage (--conformance: text and claims passes only):" : "validate coverage:",
  ...Object.entries(cov).map(([k, n]) => `  inspected ${n} ${k}`),
];
if (CONFORMANCE_ONLY) {
  coverageLines.push("  manifest and workflow-JSON passes SKIPPED by --conformance, run without the flag before go-live");
} else if (!captures.length) {
  coverageLines.push("  0 workflow captures found under workflow-json/ - EVERY workflow-JSON check above was a no-op");
}
if (!cov["claims sidecars"]) {
  coverageLines.push("  0 claims sidecars found under build/*/claims/ - EVERY claims check above was a no-op");
}
coverageLines.push("  not implemented here:", ...NOT_IMPLEMENTED.map((s) => `    - ${s}`));
console.error(coverageLines.join("\n"));

if (violations.length) { console.log(violations.join("\n")); process.exit(1); }
console.log("validate: PASS");

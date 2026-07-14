# Design Doc Set (template + module checklist)

Flat chronological numbering assigned by the registry BEFORE writing starts
(numbers, exact filenames, owner agent). `00-build-overview.md` is the
authoritative index; the count flexes per client.

## Module checklist (Registry Reviewer verifies roster completeness against this)
- [ ] 00 build overview (Assembler: index, build order, divergence log,
      deliverables audit, strategy mapping)
- [ ] business + offer brief (verified facts, exact pricing mechanics)
- [ ] ICA + brand voice (binding voice rules, wrong/right pairs)
- [ ] pipeline + stages (incl. stage -> canonical map, entry/exit criteria,
      one-owner-per-transition stage-move map)
- [ ] custom fields, tags, custom values (definitions + who-writes-what)
- [ ] customer journey map (incl. edge-case matrix, authored with the design)
- [ ] per-workflow specs (copy IN-doc, alerts embedded, one doc or grouped)
- [ ] alert catalog (N01..Nxx, copy/severity/recipients, reference only)
- [ ] conversation AI (primary + booking, paste-ready, handoff contract, KB)
- [ ] voice AI (inbound + outbound, if the registry says so)
- [ ] calendars + booking + payments (settings, products with canonical names)
- [ ] phone + compliance (number plan, submission-ready bundle content)
- [ ] domains + deliverability (sending domain, DNS records, LP domain, warm-up)
- [ ] landing pages: built outside the factory (directly with the user), NOT a
      factory deliverable; recorded in the registry for tracking and workflow
      context only, then reconciled to tracking by the
      `grom-client-factory:reconcile-lp-tracking` skill
- [ ] tracking + pixel (first-party slice, Clarity, pixel plan, CAPI map)
- [ ] post-launch onboarding runbook (instantiated, honest step labels)
- [ ] fill guide (token registry + sendable client questions message)

## Conventions the future client-build executor relies on
- Workflow spec structure per workflow: Name (exact, numbered), Trigger(s),
  Enrollment guards, Steps (numbered; each step = action type + content ref +
  waits), Exit conditions, Tags/fields written, Alerts embedded (by N-id),
  Kill-switch relationships.
- Every unknown is `{{FILL_SNAKE_CASE}}`; every doc lists its own tokens at the
  bottom; the fill guide owns the cross-doc registry.
- Claims sidecar per doc at `build/<date>/claims/<doc>.json`:
  `{ "defines": { "workflows": [], "tags": [], "fields": [], "alerts": [],
  "calendars": [], "products": [], "fill_tokens": [] }, "references": { same
  shape } }`.

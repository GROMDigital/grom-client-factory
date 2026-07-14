# Baseline Changelog

Newest first. One line per change: date, what changed, which client's
divergence log motivated it.

- 2026-07-14: landing-page build machinery removed from the factory and the new
  `reconcile-lp-tracking` skill added. Landing pages are built outside the
  factory, directly with the user; the factory records each LP as context only
  (slug, purpose, booking mechanism) for the tracking and workflow modules, and
  the built page is reconciled to the tracking design (five events, selectors,
  snippet, CSP) by `grom-client-factory:reconcile-lp-tracking`. Dropped the
  system-guide LP builder-handoff contract and the `lp/` coded-page reads across
  system-guide, compliance-brand-auditor, fill-guide-compiler, and the
  client-design ingest-answers/guide modes. Motivated by the factory's generated
  LP content being low value: LP authoring moves to a direct chat with the user.
- 2026-07-12: added the `system-guide` role (Plan 5): after the assembler, one
  agent renders the whole designed system into a self-contained
  `system-guide.html` review page (plain-English orientation, follow-one-lead
  walkthrough, inline-SVG/CSS diagrams, glossary, verbatim-vs-explanation two-layer
  split); also a standalone `guide` mode. Motivated by the acceptance dry run
  needing a single human-readable review surface.
- 2026-07-10: baseline v1 seeded from the spec, the pilot client build's doc
  set, the go-live checklist, and the live client-lp-tracking rollout process.

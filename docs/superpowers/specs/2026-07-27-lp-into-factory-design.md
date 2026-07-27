# Project 2: landing pages into the factory

Design doc. 2026-07-27. Revision 2, after reading `BUILD-GUIDE.md` end to end.
Consumes: the Standard Build (`2026-07-25-standard-build-design.md`, implemented).

## Why, and why this is not reversing a decision lightly

**Landing pages were deliberately REMOVED from this factory on 2026-07-14**, on the
grounds that the generated pages were low value.

The cause was sharper than "generated content is low value": **there was no
template to work from.** An agent asked to produce a landing page from nothing is
being asked to do design, and design-by-agent is exactly what a generic page is.

What changed is `reference/lp-library`. It now has five FINISHED, calibrated
templates (one per theme, all calendar-at-top), a `BUILD-GUIDE.md` that is an
operating manual, `CATALOG.md` as the archetype reference, and a QA harness that
checks the output mechanically.

## The whole proposal, in one paragraph

**Give the agent the library, the guide, and the client context the factory
already holds. Let it build. Then run the QA harness that already exists.**

That is the entire thing. `BUILD-GUIDE.md` is already written for an agent: read
it end to end, pick the closest template, re-theme only if needed, rewrite every
line, vary the section mix, keep the load-bearing selectors, fill the head block,
point the booking widget, run the three QA scripts. The library's own README says
the fastest way to use it is to open it in an AI tool and ask for a page.

**So the role does not need a new procedure. It needs the client context.** That
is the only thing a hand-run is missing, and it is the one thing the factory has.

## What the factory supplies that a hand-run does not

Today someone opens the library and re-types who the client is. The factory
already holds all of it:

| Input | From |
|---|---|
| what the clinic does, the offer, the real prices | `design/business-and-offer-brief.md`, registry section 1 |
| voice, tone, the words this brand uses | `design/ica-brand-voice.md` |
| exact payment product and calendar names | registry section 6 |
| the funnel slug and booking mechanism | registry section 7 |
| the LP domain and allowed origins | registry section 8 |
| the client key for the tracking head block | the manifest |
| whether there is a deposit | the Standard Build 20-series presence |

That is the value. Not a new build procedure, just a build that starts already
knowing the client.

## The one process requirement: the user picks the template

**The session ASKS which of the five templates to use, and waits.**

Template choice is the last real design decision on the page, and design-by-agent
is what got landing pages removed. It is also cheap to ask: five options, one word
back, and the user has usually spoken to the client.

This is a gate at the PM level, so the role is spawned already knowing which file
it is filling. The PM shows the five with their characters (`clinical-steel`
session-led, `direct-response` price-led, `premium-editorial` higher-ticket,
`clinical-trust` consult-led with NO deposit, `clinical-botanical` deposit-led)
and flags one mechanical inconsistency alongside the question: if the build
carries the 20-series then a no-deposit template contradicts it, and the reverse.
A flag, not a veto.

Everything after that choice is the agent's judgement, guided by the guide.
Rewriting the copy, varying the section mix, swapping an archetype where the
client needs one: that is the job, and `BUILD-GUIDE.md` step 4 explicitly asks for
it so that two clients never get the same page.

## Verification already exists

`qa/` has three scripts, and they cover most of what matters:

- `guardrails.mjs` fails on any em dash, any named CRM or automation platform, and
  any remaining `{{` placeholder.
- `render-check.mjs` checks layout overflow and console errors across four
  viewport widths.
- `token-lint.mjs` confirms only contract tokens are used, never hardcoded colours
  or fonts. 🔴 It needs an ABSOLUTE path; a relative one is silently skipped and
  prints PASS without checking anything.

Plus two hard output rules already in the guide: never ship
`your-booking-worker.invalid`, and never leave `{{META_PIXEL_ID}}` in place.

On top of that the factory validator already scans `lp/`, so `EM_DASH`,
`MALFORMED_FILL_TOKEN`, `PLATFORM_NAME_IN_LP` and `BAD_LP_EVENT` start applying to
factory output the day this lands, with no validator change.

**The one thing nothing checks is demo copy surviving.** The guardrails catch
leftover braces, but a template started from `clinical-botanical` and shipped with
Solene Skin Atelier's words in it passes every script. That is precisely the July
failure, so it needs an answer. The cheapest honest one: the five demo clinic
names are known (Verano Body Clinic, Sunna Skin Studio, Marchetti Aesthetics,
Northcott Skin & Laser, Solene Skin Atelier), so any of them appearing in output
is an automatic fail. That catches the lazy case. It does not catch a paraphrase,
and human review at the go/no-go gate remains the real backstop.

## Tracking, which fails silently if you skip it

The head block is `partials/head-tracking.html` verbatim: the inline
`window.GROM_LP` config FIRST, the async `/lp.js` loader SECOND, then the Meta
pixel. Reordering those two lines silently breaks tracking.

🔴 **Two server-side prerequisites gate everything and both fail silently:** the
client must have an entry in the tracking worker's `src/tenants.ts` with the real
LP origin in `allowedOrigins`, and that worker must have been REDEPLOYED since.
Neither is something the LP build can fix. The role states plainly whether they
are confirmed or outstanding, and never claims tracking works.

`reconcile-lp-tracking` stays, unchanged, for pages the factory did not build.

## What changes in the factory

- **`baseline/doc-set-template.md`**: the LP line flips from "built outside the
  factory, NOT a factory deliverable" to a real module with an owner.
- **The role set** gains `lp-builder`. It must be added to the systems-architect's
  valid-owner list, which is a closed set of 18 ids and is checked.
- **`skills/client-design/SKILL.md`**: `no_lps` currently gates no role. It gates
  this one again, and the template question joins the PM's gates.
- **The registry template section 7** stops saying "context only".
- Output lands at `lp/<slug>/index.html` plus short handoff notes carrying the
  template used and every outstanding item (pixel id, booking worker URL,
  tenants.ts registration).

## Open items

1. **Is the demo-clinic-name blocklist enough?** It catches the lazy case and
   nothing else. Decide whether that is acceptable with human review behind it.
2. **SEO beyond title and description.** The starters carry a per-client `<title>`
   and `<meta name="description">` (currently the demo clinic's, so they are demo
   copy and must be rewritten). They carry no Open Graph tags, no canonical, no
   structured data, so a shared link renders as a blank card. The right home is
   the LIBRARY head block, not the factory role, which makes this a small library
   change someone has to own.
3. **One page per pipeline?** A Standard Build client with two campaigns has two
   pipelines and probably two pages. Assumed but not costed.
4. **Which copy of the library does the factory read?**
   `Grom Digital Sub-Account/reference/lp-library` locally, and
   `GROMDigital/grom-lp-library` on GitHub. One declared path, or a stale copy
   becomes a silent quality regression.

## Rejected alternatives

- **Writing a new build procedure for the role.** `BUILD-GUIDE.md` is already the
  procedure, already written for an agent, already maintained by whoever maintains
  the library. A second copy in the factory would drift.
- **Letting the agent pick the template from a rubric.** It is the last design
  decision on the page, and it costs one question to keep it with a human.
- **Mechanically constraining how the agent customizes** (mandatory section swaps,
  similarity thresholds, slot manifests). Revision 1 of this doc proposed some of
  this and it was wrong on both ends: the guide already asks for section variation,
  and over-constraining the agent turns a build into a fill, which is not what the
  library is for.
- **Building fresh from the 22 archetypes.** The guide relegates this to "only when
  no template fits". For the factory, no template fitting means a human builds it.
- **Having the factory deploy the page.** Out of scope. The factory writes files.

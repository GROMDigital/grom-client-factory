# Project 2: landing pages into the factory

Design doc. 2026-07-27. Revision 1.
Consumes: the Standard Build (`2026-07-25-standard-build-design.md`, implemented).

## Why, and why this is not a repeat of a decision already made

**Landing pages were deliberately REMOVED from this factory on 2026-07-14.** The
baseline changelog records the reason plainly: "the factory's generated LP
content being low value: LP authoring moves to a direct chat with the user." The
system-guide LP builder-handoff contract and the `lp/` coded-page reads were all
torn out at the same time. Today `doc-set-template.md` says landing pages are
"built outside the factory (directly with the user), NOT a factory deliverable",
and the factory records only the slug and booking mechanism so tracking and
workflows can account for it.

That decision was correct for what existed then: an agent inventing a page from
nothing produces a generic page.

**Three things changed since, and together they invert the maths.**

1. **`reference/lp-library` now has five FINISHED templates**, not archetypes to
   assemble. Each is a single self-contained file with theme, motion and every
   section inlined, calendar-at-top, and each is a different shape from the
   others (price-led, consult-led, higher-ticket, deposit, no-deposit). The
   library's own README calls them "the quality bar and your starting point".
2. **The build model became template-first.** `BUILD-GUIDE.md` is now an
   operating manual: pick the closest template, re-theme only if the brand needs
   it, rewrite every line of copy, vary the section mix, keep the load-bearing
   selectors. That is a procedure, and a procedure is exactly what a factory role
   can execute reliably. "Compose a page from 22 archetypes" was not.
3. **A QA harness exists** (`qa/`, Playwright render plus guardrail and lint
   scripts), so the output can be checked mechanically rather than by eye.

The library even states the intended usage: open it in an AI coding tool and say
"build a landing page for this client using this library, following
BUILD-GUIDE.md." **That already IS a factory role. It is just being run by hand,
outside the factory, with the client context re-explained every time.**

**So the actual thesis: the factory is not being asked to invent a page. It is
being asked to stop making a human re-supply context it already holds.** The
factory has the business brief, the ICA and brand voice, the offer mechanics, the
declared price, the booking model, the funnel slug, and the tracking design. The
person running BUILD-GUIDE.md by hand today is re-typing all of that.

## Scope

In scope: a new factory role that produces the paste-ready page, its inputs, its
guardrails, where the output lands, how tracking is wired at build time rather
than reconciled afterwards, and how it is verified.

Out of scope: changing the library itself; hosting or deployment; the Meta pixel
install; project 3 (the factory process revamp).

## 1. The new role

**`lp-builder`**, one instance per landing page in the registry.

Phase: after the registry exists, alongside the other module roles. It depends on
the registry (section 6 for exact product and calendar names, section 7 for the LP
slug and booking mechanism, section 8 for the LP domain) and on the two content
foundations (`business-and-offer-brief.md`, `ica-brand-voice.md`).

It is added to the doc-owning role set, and the doc index gains a row per page.

### What it produces

1. `lp/<slug>/index.html`, the paste-ready page, self-contained.
2. `lp/<slug>/build-notes.md`: which template it started from, which sections it
   swapped and why, which theme, and every `{{FILL_*}}` token still open.
3. A claims sidecar like every other role.

`lp/` is already the folder the validator scans, so `PLATFORM_NAME_IN_LP` and
`BAD_LP_EVENT` start working on factory output the day this lands, with no
validator change.

### What it must never do

- **Never ship demo copy.** BUILD-GUIDE.md is explicit that rewriting every line
  is the bulk of the work. A page that still says what the template said is the
  exact failure that got LPs removed in July, and it must fail verification, not
  merely be discouraged.
- **Never invent a business fact.** Prices, hours, practitioner names,
  qualifications, guarantees, review text. Guardrail 3 already covers this and
  applies here with force, because an LP is client-facing and regulated.
- **Never rename or duplicate the load-bearing selectors** (`#lp-booking-widget`,
  `id="hero"`, `#sticky`, `nav--bar`, the inlined motion layer). The tracking
  worker has these baked in; renaming one silently kills booking events.
- **Never name the platform.** Guardrail 1, and an LP is the most client-visible
  artefact the factory produces.

## 2. Template choice is a decision with stated reasons, not a vibe

The role must state, in `build-notes.md`, why it picked the template it picked,
against three axes the library itself uses to differentiate them:

| Axis | Read from |
|---|---|
| price-led vs consult-led vs higher-ticket | the offer mechanics in the brief and registry section 1 |
| deposit vs no-deposit | registry section 6 (is there a deposit product) and the Standard Build's 20-series presence |
| palette / tone | `ica-brand-voice.md` |

**The deposit axis is not cosmetic.** `clinical-trust` is the complimentary
consult, no-deposit template; `clinical-botanical` is deposit-led. A build whose
Standard Build manifest carries the 20-series and whose page has no deposit
mechanic is internally inconsistent, and that is checkable.

## 3. Two clients must never get the same page

The library is explicit that the templates deliberately differ from each other
and that customization means swapping, adding or dropping a section archetype so
the page fits the client rather than mirroring its template.

This needs to be a REQUIREMENT with a check behind it, not advice, because an
agent's default behaviour is to copy the template and change the words. Proposed
rule: **at least one section archetype must differ from the source template**,
and `build-notes.md` must name the swap and the client reason for it.

Open question in §7: whether "one swap" is the right floor, or whether it should
be expressed as a similarity check against the starter file.

## 4. Tracking is wired at build time, not reconciled afterwards

Today `reconcile-lp-tracking` exists to hold a finished page against the tracking
design and report what to change. That skill is correct and stays, because
externally-hosted and GHL-native pages will always need it.

But for a page the factory itself builds, reconciliation after the fact is
pointless: the factory knows the client key, the worker URL and the standardized
hooks, so it can emit them correctly the first time. The role therefore writes the
head block itself: `window.GROM_LP = { clientKey }` first, the async `/lp.js`
loader second, the Meta pixel separate.

🔴 **Two prerequisites gate everything and both fail SILENTLY**, so they are
go-live checklist items, not build steps:

1. The client has an entry in the tracking worker's `src/tenants.ts` keyed by
   `clientKey`, carrying `ghlLocationId` and an `allowedOrigins` array containing
   the real LP origin.
2. That worker has been REDEPLOYED since that change.

Without both, the page looks wired and no event ever arrives. The role emits both
as explicit unchecked items and never claims tracking works.

The booking widget must USE the standardized hooks rather than declaring its own
selectors, because the worker has them baked in. That is already true of every
template, which is why "keep the load-bearing pieces intact" is a hard rule.

## 5. Verification

Three layers, in increasing cost:

1. **The factory validator**, free, already running: no em dashes, no malformed
   tokens, no platform name in `lp/`, no invented LP event names.
2. **The library's own QA harness** (`qa/`: Playwright render plus
   `guardrails.mjs` and `guides-lint.mjs`). This is the layer that catches a
   broken page rather than a broken sentence. It needs a `npm install` in `qa/`,
   so it is opt-in per run rather than always-on.
3. **Human review**, unchanged. The page goes into `system-guide.html` alongside
   everything else for the go/no-go gate.

**Demo-copy detection belongs in layer 1**, since it is the failure that removed
LPs from the factory in the first place. Cheapest workable form: the starter
templates' distinctive copy strings are a known set, so any of them surviving into
`lp/` is a violation. This wants designing properly rather than a regex, and it is
§7 open item 1.

## 6. What changes in the factory

- **`baseline/doc-set-template.md`**: the LP line flips from "built outside the
  factory, NOT a factory deliverable" to a real module with an owner. The
  reconcile note stays for external pages.
- **The role set** gains `lp-builder`. Note it must be added to the
  systems-architect's valid-owner list, which is currently a closed set of 18 ids
  and is checked.
- **`skills/client-design/SKILL.md`**: the LP-related skip flag `no_lps`
  currently "no longer gates any factory role". It gates this one again.
- **The registry template section 7** stops saying "context only".
- **`client-manifest.schema.json`**: the LP block currently lives implicitly under
  `tracking`. It likely wants `landing_pages[]` carrying slug, template used, and
  origin, so the manifest records what was built. Sizing this is §7 open item 3.

## 7. Open items

1. **How is demo copy detected?** A string blocklist harvested from the five
   starters is the obvious first answer, but it is brittle if the library changes
   and it cannot catch a paraphrase. Alternative: a similarity ratio against the
   source starter, failing above a threshold. Needs deciding before build.
2. **Is "one section swap" the right floor for differentiation**, or is it
   gameable enough to be theatre?
3. **Does the manifest need `landing_pages[]`**, or is the registry plus the
   `tracking` block sufficient? This decides whether the schema goes to version 3
   or stays at 2.
4. **Where does the library live for the factory to read?** It exists twice today:
   `Grom Digital Sub-Account/reference/lp-library` locally and
   `GROMDigital/grom-lp-library` on GitHub. The factory needs ONE declared path,
   and a stale copy is a silent quality regression.
5. **Does the role run per page or per client?** A client with two campaigns has
   two pipelines under the Standard Build, and probably two pages. Fan-out per
   page is the assumption above but has not been costed.

## 8. Rejected alternatives

- **Building fresh from the 22 archetypes.** This is what the factory effectively
  did before July, and it produced the low-value output that got the whole thing
  removed. The library's own guide relegates from-scratch assembly to "only when
  no template fits".
- **Leaving LP authoring in a direct chat with the user.** It works, and it will
  keep working. It just re-supplies the client context by hand every time, and
  that context is the one thing the factory demonstrably holds.
- **Having the factory deploy the page.** Out of scope and a different risk class.
  The factory writes files; publishing stays a human action.
- **Folding `reconcile-lp-tracking` into this role.** They serve different cases:
  this role builds a page whose tracking is right by construction; that skill
  audits a page someone else built. Merging them would lose the second case.

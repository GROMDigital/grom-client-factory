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

That decision was correct for what existed then, and the diagnosis is sharper than
"generated content is low value". **The pages were bad because there was no
template to work from.** An agent asked to produce a landing page from nothing is
being asked to do design, and it produced design-by-agent, which is what a generic
page is.

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

**So the actual thesis, and it is narrower than "the factory builds landing pages
now": the DESIGN IS ALREADY LOCKED, so the remaining work is not design.** The
five templates ARE the design. Layout, theme, motion, section composition, the
booking card in the hero fold: all decided, all finished, all rendering the moment
you copy the file.

What is left per client is copy, SEO, and wiring. That is a filling job, and a
filling job is something a factory role can do well, precisely because it is not
the job that failed in July.

🔴 **The role does NOT design a page. It does not compose one. It fills a locked
one.** Any framing that lets it "build" a page reintroduces the exact failure.

And the context that filling job needs, the factory already holds: the business
brief, the ICA and brand voice, the offer mechanics, the declared price, the
booking model, the funnel slug, and the tracking design. The person running
BUILD-GUIDE.md by hand today is re-typing all of it.

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

## 2. 🔴 The USER picks the template. The agent never does.

**Hard requirement, not a default.** The session ASKS which of the five templates
to use, and waits for an answer.

The reason is the same reason the design is locked at all. Template choice is the
last remaining design decision on the page, and design-by-agent is what got
landing pages removed from this factory. Handing the agent a rubric and letting it
choose gives that decision back to the model with extra steps.

It is also cheap to ask. Five options, the user knows the client and has usually
spoken to them, and the answer is one word.

Mechanically this makes template choice a GATE at the PM level, not a step inside
the role. The PM asks, the user answers, and the role is spawned already knowing
which file it is filling. The role never receives a choice it could get wrong.

The PM presents the five with their differentiators, so the question is answerable
without opening the library:

| Template | Shape |
|---|---|
| `clinical-steel` | cool ice and steel-blue, session-led |
| `direct-response` | warm amber, bold, price-led |
| `premium-editorial` | ivory and charcoal, editorial, higher-ticket |
| `clinical-trust` | cool sage, credibility-led, complimentary consult, NO deposit |
| `clinical-botanical` | porcelain and deep-green, deposit-led |

**One consistency note the PM surfaces WITH the question**, because it is
mechanical and the user may not have it in mind: if the build's manifest carries
the 20-series (a deposit exists) then a no-deposit template such as
`clinical-trust` contradicts the build, and the reverse holds too. A flag
alongside the question, never a veto. The user still chooses.

## 3. Changes are SMALL and stay inside the template

The role rewrites copy and SEO. It does not restructure.

An earlier draft of this spec proposed a mandatory rule that at least one section
archetype must differ from the source template, so that two clients never get the
same page. **That is dropped, and it was wrong.** It pushed the agent toward
exactly the behaviour that produced bad pages, and it optimised for a problem the
setup already handles: five distinct templates, chosen deliberately per client and
filled with genuinely client-true copy, do not collide often.

Section swaps stay POSSIBLE, via the `blocks/` archetypes and `CATALOG.md`,
because a client sometimes genuinely needs a different section. They are a
USER-REQUESTED change, never something the role does on its own initiative, and
any swap is recorded in `build-notes.md`.

The residual risk is real and small: two clients in the same market, given the
same template with similar offers, will look related. The levers for that are the
template choice, which is now a human's, and the copy, which is the bulk of the
work anyway.

## 3A. SEO is part of the fill, and the templates only cover half of it

The starters already carry a per-client `<title>` and `<meta name="description">`,
both filled with the demo client's data. That makes them exactly as dangerous as
demo body copy: they ship verbatim unless rewritten. Both are in scope for the
role, and both count as demo-copy failures if they survive.

**What the templates do NOT carry today**, and what therefore needs deciding
before this is built: Open Graph and Twitter card tags (so a shared link renders
as a blank card), a canonical URL, and any structured data. For a local clinic
page, `LocalBusiness` or `MedicalBusiness` schema with address, phone and hours is
the obvious candidate.

Two ways to close it:

1. **Add them to the library's head block**, so every page gets them and the
   factory just fills slots. Correct home, but it is a change to the LIBRARY,
   which sits outside this project's scope as written.
2. **Have the role emit them**, which makes the factory and the library disagree
   about what a page contains, and leaves hand-built pages silently without them.

Option 1 is right. It makes this project depend on a small library change, which
is worth stating now rather than discovering mid-build.

🔴 Structured data must carry no invented facts. Hours, address and phone are
precisely the fields guardrail 3 forbids guessing, so without a verified source
they are tokens and the schema block is incomplete by design rather than plausible
and wrong.

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
   source starter, failing above a threshold. Note the starters' `<title>` and
   `<meta name="description">` are demo copy too and must be in whatever net gets
   used. Needs deciding before build.
2. **Does the SEO head block go into the library (option 1 in §3A)?** If yes this
   project has a dependency on a library change and someone has to own it.
3. **Does the manifest need `landing_pages[]`**, or is the registry plus the
   `tracking` block sufficient? This decides whether the schema goes to version 3
   or stays at 2. It would also be the natural home for "which template was used",
   which is otherwise only in `build-notes.md`.
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
  no template fits". The factory never gets that escape hatch: no template fits
  means a human builds it, not that the agent starts composing.
- **Letting the agent choose the template from a rubric.** Rejected in §2. It is
  the same class of decision as the one that failed, dressed as a heuristic.
- **A mandatory section swap per client.** Rejected in §3. It manufactures
  restructuring work in a role whose entire value is that it does not restructure.
- **Leaving LP authoring in a direct chat with the user.** It works, and it will
  keep working. It just re-supplies the client context by hand every time, and
  that context is the one thing the factory demonstrably holds.
- **Having the factory deploy the page.** Out of scope and a different risk class.
  The factory writes files; publishing stays a human action.
- **Folding `reconcile-lp-tracking` into this role.** They serve different cases:
  this role builds a page whose tracking is right by construction; that skill
  audits a page someone else built. Merging them would lose the second case.

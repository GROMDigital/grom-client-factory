---
name: reconcile-lp-tracking
description: Reconcile a client landing page (an HTML file on disk, or an external page such as a GoHighLevel-hosted page) against a Grom client's tracking design and the live client-lp-tracking contract, so the fixed LP events actually fire. Covers the current HOSTED-LOADER model (a two-line window.GROM_LP + async /lp.js head block, logic served by the grom-lp-events worker) and the tenants.ts server-side registration it depends on. Knows which events can fire on a library-built page (standardized booking widget) versus an external or GHL-native-iframe page (lp_view only). Advises only: emits a reconciliation report, the paste-ready head block with the client key set, the exact DOM hooks to add by hand, and the tenants.ts / deploy prerequisites to confirm. Never edits the landing page, the design docs, or a live account. Use after a client's landing page exists, whether you built it from the lp-library or it is an externally-hosted page.
---

# reconcile-lp-tracking

Landing pages are built OUTSIDE this factory: either composed from the Grom
lp-library archetypes, or built directly with the user, or already living as an
external page (for example a GoHighLevel-hosted page). This skill is the join
between that page and the tracking the `client-design` factory specified. Its
one job: read the page, hold it against the client's tracking design and the
live `client-lp-tracking` contract, and tell the user exactly what to change so
the events fire.

You ADVISE. You never edit the landing page, never edit a design doc, never
write to a live account, never deploy. Your whole output is a report plus a
paste-ready head block plus a list of hooks to add by hand plus the server-side
prerequisites to confirm.

## The current tracking model (read this before you reconcile)

Tracking is delivered as a HOSTED LOADER, not a big inline snippet. A tracked
page carries, in its `<head>`:

1. An inline config that MUST come first: `window.GROM_LP = { clientKey: "<the client key>" }`.
2. An async loader right after it: `<script async src="https://grom-lp-events.gromdigital001.workers.dev/lp.js"></script>`.
3. The Meta Pixel (separate, per client).

The ~90 lines of tracking logic live once on the `grom-lp-events` worker, served
at `GET /lp.js`. That served script reads the key from `window.GROM_LP.clientKey`
(and no-ops if absent, so no key means no tracking, never an error), watches the
STANDARDIZED booking hooks `#lp-booking-widget, #sk-booking-widget` (mount) and
`.time-chip` (slot), fires `lp_view` on load, and POSTs events to `/e/<clientKey>`.
Because the selectors are baked into the worker, a page no longer sets its own
`WIDGET_SELECTOR` / `SLOT_SELECTOR`: the page's booking widget must USE those
standardized hooks, or its booking events cannot fire.

Two server-side prerequisites gate everything, and both fail SILENTLY (events
look wired but never arrive):

- The client must have an entry in the worker's `src/tenants.ts` (a map keyed by
  `clientKey`, each entry holding `clientKey`, `ghlLocationId`, and an
  `allowedOrigins` array containing the exact origin the page serves from).
- That worker must have been DEPLOYED after the `tenants.ts` change.

Some older live pages (for example SK Skin) still carry the legacy inline
snippet from `client-lp-tracking/landing-pages/`. Treat that as legacy: it still
works, but new or reconciled pages use the hosted loader above.

## Which events can fire depends on the page (decide this first)

- **Library-built page** (composed from the lp-library `booking--selector`
  archetype, or any page whose booking widget mounts at `#lp-booking-widget`
  with `.time-chip` slots): all five events can fire.
- **External / GHL-native-iframe page** (for example a GoHighLevel page whose
  booking is a cross-origin `leadconnectorhq.com/widget/booking/...` iframe):
  only `lp_view` (and `offer_viewed`, if a trigger element is wired) can fire.
  The booking funnel events CANNOT: a page cannot observe clicks inside a
  cross-origin iframe, and the booking POST goes to GoHighLevel, not to our
  worker. Do NOT invent selectors to "fix" this; it is a platform limit, not a
  wiring gap. For conversions on that page, advise the Meta Pixel (fired on the
  booking confirmation / thank-you page) plus the client's GoHighLevel
  appointment data. State this plainly in the report.

## Phase 0: gates (in order)

1. FACTORY CONFIG. Read `~/.grom-factory.json`. Resolve the live tracking repo
   from `deps["client-lp-tracking"].path`. If the file or that dep is missing,
   stop and point at `grom-client-factory:doctor`; do not proceed on a guess.
2. CLIENT FOLDER. Argument if given, else cwd. Never guess the folder.
3. LANDING PAGE. A file path argument if given; else discover `*.html` under
   `<client>/lp/`. If the page is external and there is no local file, ask the
   user for the URL and the page kind (library-built or GHL-native-iframe) and
   reconcile against what they can confirm; never reconcile against a page you
   have not read or had described in concrete DOM terms.
4. TRACKING DESIGN DOC. Find `<client>/design/tracking-and-pixel.md` (the
   `tracking-pixel` owner doc). If absent, reconcile against the registry plus
   the live repo defaults only, and flag that the client has no tracking design
   doc yet.

## Inputs (read in this exact order)

1. `baseline/guardrails.md` from the plugin root, verbatim, first. Its rules are
   absolute.
2. THE LIVE TRACKING REPO, read FRESH at run time from the resolved path. The
   worker under `worker/` is authoritative for the current contract: `src/index.ts`
   (the `/lp.js` and `/e/:clientKey` routes), `src/lp-js.ts` (the served tracking
   IIFE: the event names, the `window.GROM_LP` key read, the standardized
   selectors, the `/book` submit hook), and `src/tenants.ts` (the registration
   shape). Also read `landing-pages/` for the legacy inline snippet still on some
   live pages. If the repo has changed since this skill was written, the repo
   wins on the contract and the selectors.
3. THE CLIENT TRACKING DESIGN DOC (`tracking-and-pixel.md` if it exists): the
   chosen `clientKey`, the booking mode, the LP slugs tracked, the
   `allowed_origins`, and the Meta Pixel plan. These are what the page is
   supposed to match.
4. THE BINDING REGISTRY `<client>/build/<runDate>/architecture-final.md` if
   present: section 6 (booking model), section 7 (LP slugs and their booking
   mechanism), section 8 (`allowed_origins`). Registry spellings are law; the
   `clientKey` and slugs must match it character for character.
5. THE LANDING PAGE itself, in full. Read the actual DOM; never assume a hook
   exists.

## The reconciliation (run per landing page)

First classify the page (library-built vs external / GHL-native-iframe), then
check each of the fixed events plus install and the silent-failure traps. The
five event names are exact and immutable: `lp_view`, `booking_started`,
`booking_cta_clicked`, `booking_submitted`, `offer_viewed`. No variants.

1. **`lp_view` / loader install.** Does the `<head>` carry the two-line loader:
   an inline `window.GROM_LP = { clientKey: "..." }` that PHYSICALLY PRECEDES the
   async `/lp.js` `<script>` (an async loader that runs before the key is set
   no-ops)? Does `clientKey` match the tenant map and the tracking doc? Head-paste
   ADDS: confirm the loader is added to existing head content, not replacing it.
   Confirm this is a LANDING page, not a confirmation or thank-you page.
2. **`booking_started`.** Library-built: does the booking widget mount at
   `#lp-booking-widget` (or the SK-legacy `#sk-booking-widget`)? If a booking
   container exists but uses a different id, give the user the exact hook to add
   (`id="lp-booking-widget"`) on the real element you quote from the page.
   External GHL-iframe: mark this event as NOT POSSIBLE (cross-origin iframe) and
   move on, do not offer a selector.
3. **`booking_cta_clicked`.** Library-built: do the selectable slots carry
   `.time-chip`? Same add-the-hook handling if a slot exists without the class.
   External GHL-iframe: NOT POSSIBLE.
4. **`booking_submitted`.** Library-built widget that POSTs to `/book`: the
   served script fires client-side on `res.ok && data.ok === true`, so confirm
   the widget posts to the booking worker's `/book`. External GHL-iframe:
   NOT POSSIBLE from the page; advise the Meta Pixel on the confirmation page
   plus GoHighLevel appointment data instead.
5. **`offer_viewed`.** The independent engagement signal, not part of the ordered
   funnel. If the design specifies a trigger element, confirm it exists;
   otherwise note it optional and unfired. This one CAN fire on an external page.
6. **`tenants.ts` registration + deploy (the number-one silent failure now).**
   Is the client's `clientKey` present in the worker's `src/tenants.ts`, with the
   serving origin in its `allowedOrigins`? Has the worker been deployed since?
   You are advising, so you cannot run the deploy: state clearly whether the
   entry exists in the repo you read, and flag the deploy as a prerequisite the
   worker maintainer must confirm. Missing entry or missing deploy means every
   event is silently dropped.
7. **CSP.** Does the page carry a Content-Security-Policy whose `connect-src`
   would block the beacon to the worker origin, or `script-src` the `/lp.js`
   loader? If a CSP is present and the worker origin is not allowed, flag it as a
   BLOCKER: the events look wired but never arrive.
8. **Meta Pixel placement.** Is the PageView on this content page (and, for an
   external page, is there a plan to fire it on the booking confirmation page for
   the conversion signal)? If this file is a redirect or geo-router route,
   PageView must NOT be here; it belongs on the content page the route lands on.

## Output (advise only, printed to the user)

Print the report in chat. Offer to also write it to
`<client>/lp/reconcile-report.md` only if the user asks; never write it silently.

- **A. Page kind.** Library-built, or external / GHL-native-iframe, with the one
  line of consequence (which events are even possible on this page).
- **B. Verdict table.** One row per check (the five events, loader install,
  tenants.ts + deploy, CSP, Meta Pixel): MATCH / MISSING / MISMATCH / NOT
  POSSIBLE / BLOCKER, with a one-line reason.
- **C. Paste-ready head block.** The hosted loader with `clientKey` set to this
  client, presented as plain copy-pasteable text (not a fenced code block):
  the inline `window.GROM_LP` config first, then the async `/lp.js` loader, then
  the Meta Pixel with the pixel id as a `{{META_PIXEL_ID}}` token if unknown.
  Never invent a key or a pixel id.
- **D. Exact DOM hooks to add.** For a library-built page missing a hook, the
  precise id/class (`id="lp-booking-widget"`, `class="time-chip"`) and the exact
  element to add it to, quoted from the page. For an external GHL-iframe page,
  state plainly that no hook can capture in-iframe booking steps.
- **E. Prerequisites + blockers.** The tenants.ts entry to add and the worker
  deploy to run (whoever maintains `client-lp-tracking/worker`), any CSP that
  will kill the beacon, any serving origin missing from `allowedOrigins`, any
  Meta Pixel on a redirect route. Each with its one fix.

## Boundaries

- Advise only. Never edit the landing page, never edit a design doc, never write
  to a live account, never deploy, never touch GHL or the worker.
- Read the live `client-lp-tracking` repo (worker `src/` first) fresh every run;
  it wins on the contract, the routes, and the selectors if it has changed.
- Never emit a CAPI access token or any secret. If a token is needed, emit a
  placeholder and say the real value is provisioned outside these docs.
- The five event names are exact and immutable. No variants, no synonyms.
- Do not guess the page's DOM. Read the actual page. If a hook cannot be resolved,
  say so and emit the hook to add, never a guessed selector. For an external
  GHL-iframe page, do not pretend booking events are recoverable.
- Never name the platform in anything a lead could see; the loader and report
  copy speak of "the Grom system" only, with no gohighlevel.com URL.
- No em dashes anywhere; use commas, colons, or "to".

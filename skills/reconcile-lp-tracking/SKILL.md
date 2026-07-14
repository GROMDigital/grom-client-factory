---
name: reconcile-lp-tracking
description: Reconcile an externally-built landing page (an HTML file on disk) against a Grom client's tracking design and the live client-lp-tracking contract, so the five fixed LP events actually fire. Advises only: emits a reconciliation report, the paste-ready head snippet with CLIENT_KEY / WORKER_URL / selectors set to the landing page's real DOM, and the exact DOM hooks to add by hand. Never edits the landing page, the design docs, or a live account. Use after you have built a client's landing page yourself, outside the factory.
---

# reconcile-lp-tracking

Landing pages are built OUTSIDE this factory: you design and code them directly
with the user, page by page, in a normal chat. This skill is the join between
that hand-built page and the tracking the `client-design` factory already
specified. Its one job: read the built landing page as a file on disk, hold it
against the client's tracking design and the live `client-lp-tracking` contract,
and tell the user exactly what to change so all five fixed events fire.

You ADVISE. You never edit the landing page, never edit a design doc, never
write to a live account, never deploy. Your whole output is a report plus a
paste-ready snippet plus a list of hooks to add by hand.

## Phase 0: gates (in order)

1. FACTORY CONFIG. Read `~/.grom-factory.json`. Resolve the live tracking repo
   from `deps["client-lp-tracking"].path`. If the file or that dep is missing,
   stop and point at `grom-client-factory:doctor`; do not proceed on a guess.
2. CLIENT FOLDER. Argument if given, else cwd. Never guess the folder.
3. LANDING PAGE FILE(S). The path is an argument if given; else discover
   `*.html` under `<client>/lp/`. If none are found, ask the user for the file
   path and stop until you have it. You reconcile against a real file, never
   against a described page.
4. TRACKING DESIGN DOC. Find `<client>/design/tracking-and-pixel.md` (the
   `tracking-pixel` owner doc). If it is absent, say so and reconcile against
   the registry plus the live repo defaults only, flagging that the client has
   no tracking design doc yet.

## Inputs (read in this exact order)

1. `baseline/guardrails.md` from the plugin root, verbatim, first. Its rules are
   absolute.
2. THE LIVE TRACKING REPO, read FRESH at run time from the resolved path:
   `README.md`, the whole `landing-pages/` folder (`grom-lp.js`,
   `head-snippet.html`, its `README.md`), and `booking-steps/README.md`. This is
   the authoritative snippet contract, the selector defaults, the event hooks,
   and the CSP failure mode. If it has changed since this skill was written, the
   repo wins on the contract and the process.
3. THE CLIENT TRACKING DESIGN DOC (`tracking-and-pixel.md` if it exists): the
   chosen `CLIENT_KEY`, `WORKER_URL`, booking mode, `WIDGET_SELECTOR` /
   `SLOT_SELECTOR`, the LP slugs tracked, the `allowed_origins`, and the Meta
   Pixel plan. These are what the page is supposed to match.
4. THE BINDING REGISTRY `<client>/build/<runDate>/architecture-final.md` if
   present: section 6 (booking model), section 7 (LP slugs and their booking
   mechanism), section 8 (`allowed_origins`). Registry spellings are law; the
   `CLIENT_KEY`, worker origin, and slugs must match it character for character.
5. THE LANDING PAGE FILE(S) on disk, each one in full. You read the actual DOM;
   you never assume a selector exists.

## The reconciliation (run per landing page file)

Check each of the five fixed events, plus install and the silent-failure traps.
The five names are exact and immutable: `lp_view`, `booking_started`,
`booking_cta_clicked`, `booking_submitted`, `offer_viewed`. No variants.

1. **`lp_view` / snippet install.** Is the tracking head snippet present in this
   file's `<head>`? Does its `CLIENT_KEY` match the tenant map and the tracking
   doc, and its `WORKER_URL` match the deployed worker? Head-paste ADDS: confirm
   the snippet is added to existing head content, not replacing it. Confirm this
   file is a LANDING page, not a confirmation or thank-you page (page-level
   install only; funnel-level fires phantom `lp_view`s).
2. **`booking_started`.** Does an element matching `WIDGET_SELECTOR` actually
   exist in this file's DOM? If the tracking doc's selector matches nothing in
   the file, that is a MISMATCH: quote the real candidate container(s) you found
   and give the user a choice, either the selector to set in the snippet to
   match the real DOM, or the exact id/class hook to add to the widget element.
3. **`booking_cta_clicked`.** Does `SLOT_SELECTOR` match the slot / time-chip
   elements in the DOM? Same MISMATCH handling as above.
4. **`booking_submitted`.** Read the page's real booking mechanism from the DOM
   and confirm it matches the tracking doc's chosen mode. In-page widget that
   POSTs to a `/book` endpoint: the snippet's fetch wrapper fires client-side on
   `res.ok && data.ok === true`, so confirm the widget posts to `/book`. Native
   calendar embed with no in-page widget: `booking_submitted` cannot fire from
   the landing snippet, so flag that it must come from a confirmation-page
   snippet or server-side, and flag hard if the LP is native-calendar but the
   tracking doc assumed an in-page widget.
5. **`offer_viewed`.** The independent engagement signal, not part of the
   ordered funnel. If the design specifies a trigger element for it, confirm the
   element exists; otherwise note it as optional and unfired.
6. **CSP (the number-one silent failure).** Does the page carry a
   Content-Security-Policy (meta tag or header note) whose `connect-src` would
   block the `sendBeacon` to the worker origin? If a CSP is present and the
   worker origin is not allowed, flag it as a BLOCKER: the events look wired but
   never arrive.
7. **Meta Pixel placement.** Is the PageView on this content page? If this file
   is a redirect or geo-router route, PageView must NOT be here; it belongs on
   the content page the route lands on.
8. **`allowed_origins`.** Confirm the origin this page will serve from (per the
   registry section 8 / the LP domain plan) is in the worker tenant's
   `allowed_origins`. If the serving origin is not on that list, the beacon is
   rejected: flag it.

## Output (advise only, printed to the user)

Print the report in chat. Offer to also write it to
`<client>/lp/reconcile-report.md` only if the user asks; never write it
silently.

- **A. Verdict table.** One row per check (the five events, install, CSP, Meta
  Pixel, origin): MATCH / MISSING / MISMATCH / BLOCKER, with a one-line reason.
- **B. Paste-ready head snippet.** The live repo's `head-snippet.html` with
  `CLIENT_KEY`, `WORKER_URL`, and the widget / slot selectors filled to match
  THIS page's real DOM. Where a value is genuinely unknown, emit a
  `{{FILL_SNAKE_CASE}}` token, never an invented value. Present it as plain
  copy-pasteable text, not a fenced code block.
- **C. Exact DOM hooks to add.** For every MISSING or MISMATCH selector, the
  precise id or class to add and the exact element in the page to add it to
  (quote the element from the file), so the user applies it by hand.
- **D. Blockers.** Any CSP that will silently kill the beacon, any
  native-calendar-versus-widget mode mismatch, any serving origin missing from
  `allowed_origins`, any Meta Pixel on a redirect route. Each with the one fix.

## Boundaries

- Advise only. Never edit the landing page, never edit a design doc, never write
  to a live account, never deploy, never touch GHL.
- Read the live `client-lp-tracking` repo fresh every run; it wins on the
  snippet contract and the selectors if it has changed.
- Never emit a CAPI access token or any secret. If a token is needed, emit a
  placeholder and say the real value is provisioned outside these docs.
- The five event names are exact and immutable. No variants, no synonyms, no
  additions.
- Do not guess the page's DOM. Read the actual file. If a selector cannot be
  resolved from the file, say so and emit the hook to add, never a guessed
  selector.
- Never name the platform in anything a lead could see; the snippet and report
  copy speak of "the Grom system" only, with no gohighlevel.com URL.
- No em dashes anywhere; use commas, colons, or "to".

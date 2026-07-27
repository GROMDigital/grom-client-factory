# Project 3: the factory process revamp

Design doc. 2026-07-27. Revision 1.
Consumes: the Standard Build (`2026-07-25-standard-build-design.md`, implemented).
Independent of project 2 (`2026-07-27-lp-into-factory-design.md`).

## Why

The Standard Build fixed WHAT gets built. This project is about HOW the factory
runs: what it reads before it starts, what it asks the client, where a human
looks, and whether the output is good enough to hand over.

Four parts, carried since the original scoping. They are not equally ready, and
this doc says so rather than pretending otherwise: parts 1 and 2 are specifiable
now, part 3 is a small deliberate change, part 4 needs evidence first.

## 1. The strategy front door

### The problem, with a live example from today

The factory's phase-0 gates check the folder, the mode, whether a brownfield
capture exists, and what materials are present. **Nothing reads the strategy for
completeness before agents start.** The adequacy verdict exists, but it is
section 5 of the journey architect's own output, which means it lands after the
foundation roles have already run against whatever the strategy did or did not
say.

A live case arrived while this was being written. The Better By Ati strategy
(36 pages, dropped 2026-07-27) is detailed: single Hair PRP campaign, Meta
instant lead forms, a £50 booking deposit, deposit-paid as a tracked step. It
never mentions the booking platform. The client reportedly books through
Treatwell.

Under the Standard Build that one unstated fact is not a detail:

- `booking.model = external` SUPPRESSES `04 - Booked + Reminders` and
  `05 - Reschedule Handler`, and REQUIRES `25 - External Booking Status Poll`.
- Without 25 the client has no pipeline tail at all: stages 5 through 8 can never
  fire, because attendance state lives in a diary GHL cannot see.
- The £50 deposit independently requires the whole 20-series.

So a single missing sentence changes the workflow roster in two directions at
once. Discovering that after the registry is written means rewriting the registry.

### The proposal

A cheap pre-flight pass, before any writing agent runs, whose only job is to read
the strategy and produce a **gap list phrased as questions to a human**, not
assumptions. It is a gate, not a document.

It checks for the facts the Standard Build makes load-bearing:

| Fact | Why it is load-bearing now |
|---|---|
| booking platform, and whether the diary lives outside the system | flips `booking.model`, adds or removes three workflows |
| deposit, and its amount | the entire 20-series |
| treatment price, per campaign | opportunity value at card creation; zero is a defect |
| campaign count | one pipeline per campaign, so this IS the pipeline count |
| who at the clinic records treatment outcomes | the pipeline tail is manual; unowned means stages 7 and 8 never move |
| voice AI in scope | workflow 40, and the voice half of the agent contract |
| market and geo | compliance path and phone bundle |

The output is a short list the user answers before the fan-out, or explicitly
defers as a token. **It must not infer.** The existing guardrail already says a
gap becomes a question, never a guess; this moves that discipline earlier, where
it is cheap.

Note this does not replace the journey architect's adequacy verdict, which judges
the strategy as a whole. This checks the specific facts that change the build's
shape.

## 2. Ingesting the onboarding answers

### The problem

The sequence today is backwards. The factory runs, and the LAST thing it produces
is a fill guide: a token registry plus a sendable questions message for the
client. The user emails it, the client replies, the user pastes the reply, and
`ingest-answers` mode fills the tokens and amends the registry for anything
design-changing.

Meanwhile **the onboarding portal has already asked the client a pile of these
questions and holds structured answers.** `grom-onboarding-form/lib/schema.ts`
defines, among others: treatments offered (a fixed enum of thirteen), clinic
stage, where patients currently come from, whether they run ads today and on
which platform, what tracking is already installed, and budget band.

Those overlap directly with what the factory later asks. So the client gets asked
twice, which reads as disorganised, and the factory designs against tokens for
facts that were already known.

### The proposal

Seed the run from the portal's answers, so the fill guide only asks what is
genuinely still unknown.

Two decisions this needs:

1. **Transport.** The portal is a Next.js app on Vercel with a Supabase database.
   The factory is a local skill. The cheapest correct move is an export the user
   drops into `strategy/`, not a live database read from the factory. A live read
   couples a design tool to production and needs credentials it should not have.
2. **Trust level.** A portal answer is a client's self-report, not a verified
   fact. Treatments offered is reliable; "what tracking is installed" is exactly
   the kind of answer that is wrong in good faith. So portal answers seed and are
   labelled as claimed, and anything load-bearing still gets verified against the
   account capture where one exists.

The clean framing: **the portal answers a question the factory would otherwise
ask; the account capture answers what is actually true; the strategy says what we
intend to do.** Three sources, different authority, and the factory currently
reads only the third.

## 3. Human gate placement

Today there are two hard gates: preflight confirmation before anything spawns,
and the post-registry gate as one message before the module fan-out. Both are in
sensible places: one before spending, one after the most consequential single
artefact.

This part is therefore small, and the honest recommendation is **do not add
gates**. Two proposed adjustments only:

1. **The front door in part 1 becomes the real first gate**, and preflight folds
   into it. Confirming the folder and confirming the strategy is buildable are the
   same conversation, and splitting them means the user is interrupted twice
   before anything happens.
2. **A gate is only worth having if the answer can change the outcome.** The
   post-registry gate qualifies. Any gate added later must clear that bar or it
   is just a pause.

## 4. Agent output quality

**This part is not specifiable yet, and writing it as though it were would be the
same mistake as revision 1 of the Standard Build.**

The complaint is real and long-standing, but the factory already carries four
quality mechanisms (`registry-reviewer`, `journey-leak-auditor`,
`compliance-brand-auditor`, `registry-reconciler`) plus the validator and the
prompt linter. "Output quality is bad" does not say which of those is failing, or
whether the problem is the prompts, the model, or the inputs.

What is needed first is evidence from ONE clean run of the rewritten factory:
which docs came back thin, which auditor missed what, where a human had to
rewrite rather than accept. **Better By Ati is the obvious candidate**, and its
Treatwell gap makes it a genuinely useful test rather than a happy path.

Until that run exists, this section stays a heading.

## 5. Sequencing

1 and 2 are independent of each other and both are worth doing. 3 is small and
rides along with 1. 4 waits for evidence.

Recommended order: **the front door first**, because it is the cheapest change
with the largest failure it prevents, and because the Treatwell case is a live
demonstration that it is needed. Onboarding ingest second. Quality last, once
there is something to look at.

## 6. Open items

1. **Does the front door run as a role, or as PM logic inside `SKILL.md`?** A role
   costs an agent and produces an artefact; PM logic is free but harder to keep
   honest. Leaning PM logic with a fixed checklist, since the output is a handful
   of questions, not a document.
2. **What is the portal export's shape**, and who produces it? An admin button in
   the portal, or a query the user runs? This decides whether project 3 touches
   the portal repo at all.
3. **Does the front door BLOCK on an unanswered load-bearing fact, or proceed with
   a token?** Blocking is safer and more annoying. Probably: block on the ones
   that change the workflow roster (booking platform, deposit), token the rest.
4. **What happens to `ingest-answers` mode** once the portal seeds the run? It
   still has a job (the client's reply to the residual questions), but its shape
   changes.

## 7. Rejected alternatives

- **Having the factory read the portal database directly.** Couples a local design
  tool to production and needs credentials it has no business holding.
- **Trusting portal answers as verified facts.** They are self-reports. The
  tracking question in particular is one clients answer wrongly in good faith.
- **Adding more human gates.** The two that exist are in the right places. More
  gates make a slow process slower without changing any outcome.
- **Specifying the quality work now.** Doing it without evidence is how revision 1
  of the Standard Build asserted a mechanism that measured 3% coverage in reality.

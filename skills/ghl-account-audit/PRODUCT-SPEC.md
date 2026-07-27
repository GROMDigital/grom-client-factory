# The weekly account auditor — what we are actually building

Owner's specification, restated here verbatim in substance so it cannot be lost or drifted from
again. Everything in this repository is subordinate to this document. When an implementation
decision and this document disagree, this document wins.

## What it is

A weekly account-auditing system that examines how leads move through each GHL account and
identifies **why** they are not:

1. Responding to nurture messages
2. Engaging with the AI agent
3. Booking appointments
4. Showing up for appointments
5. Rebooking after a cancellation or no-show
6. Progressing through the sales journey

It goes **beyond reporting numbers**. It reconstructs what happened, investigates the underlying
cause, and produces implementation-ready solutions for the team to review.

## Why

A standard report says: 100 leads, 20 replies, 5 appointments. That is what happened. It does not
say:

- Why the other 80 did not respond
- Which message or delay caused the biggest drop-off
- Whether leads were enrolled in the correct workflow
- Whether workflow steps executed correctly
- Whether the AI handled replies effectively
- Whether the offer, positioning or copy was compelling
- Why booked leads cancelled or failed to attend
- What should actually be changed

## Inputs

Account context · GHL account data · tech-team account-data process · onboarding portal data when
relevant. All of it normalised into one evidence set, then connected: workflow behaviour,
conversations, appointments and commercial outcomes into ONE lead-journey analysis.

## The three analysis areas, and ALL THREE RUN EVERY TIME

**The auditor decides what to analyse. It is never told.** Being asked which lane to run, or which
metric to look at, is the failure this product exists to remove.

### 1. Lead journey and KPI analysis

Reconstruct the complete journey: lead created → first contact → first engagement → AI or human
conversation → qualification → appointment booked → confirmed/cancelled/no-show → attended → sale
or follow-up → reactivation when required.

Identify where leads drop out and **which stage is the largest commercial leak**. For the Grom
agency account, also the separate client onboarding journey toward campaign launch readiness.

### 2. Workflow configuration AND EXECUTION analysis

Both how workflows are designed and what happened when contacts entered them:

- Triggers and enrollment rules
- Message order and timing
- Wait steps and communication gaps
- Branches, conditions and handoffs
- Duplicate or conflicting automation
- Contacts becoming stuck at particular steps
- Steps that did not execute as expected
- **Differences between the intended journey and the actual customer experience**

This distinguishes a weak strategy from a technical execution problem.

### 3. Conversation, marketing and AI analysis

Review actual customer interactions to understand why leads engaged, stopped responding, objected,
booked, cancelled or disappeared. Evaluates SMS and email copy, opening messages and angles, calls
to action, offer clarity, timing and frequency, AI responses and qualification behaviour,
conversation friction, objections and recurring questions, voice AI transcripts when available,
sentiment and intent, and whether the journey creates enough trust and motivation to book.

## Root-cause investigation

All three lanes feed one investigation step. This is where the causes are established rather than
the symptoms listed.

## The three outputs

### Weekly account report
What the account is currently doing · how leads moved · what improved or declined · where the
largest leaks were · which findings are evidence-supported · what needs further investigation.

### Implementation-ready solution packages
**It does not stop at "improve the nurture workflow."** Where the evidence supports a change it
prepares the actual solution: revised workflow logic, new triggers/branches/wait times, complete
SMS or email sequences, revised AI instructions, new follow-up or reactivation flows, cancellation
and no-show recovery sequences, alternative marketing angles, A/B testing plans, and measurement
and validation criteria.

Prepared LOCALLY for review. Nothing implemented automatically without approval.

### Prioritised improvement backlog
Ranked on: expected commercial impact · strength of supporting evidence · number of leads affected
· urgency · implementation effort · risk · ability to test the proposed solution.

## The weekly improvement cycle

    collect weekly evidence -> reconstruct lead journeys -> identify the largest leaks
      -> investigate the cause -> produce solution packages -> human review and approval
      -> implement selected changes -> observe the next closed period
      -> did performance improve?  yes: verify and retain the change
                                   no:  reopen or revise the finding
      -> back to collect

Compare a **completed** reporting period against the previous equivalent period where there is
enough data.

**Follow leads beyond the original seven-day window when necessary.** A lead generated near the end
of a week may not book or attend until the following week. This prevents unfinished journeys from
being wrongly classified as failures. (This is what the maturity ladder in `lib/metrics.mjs` exists
for: the same measurement at three maturities, each over roughly double its allowed lag.)

## Human approval stays in the loop

Increasingly self-correcting, permanently human-controlled:

1. The auditor identifies and explains the problem
2. It provides the supporting evidence
3. It prepares the proposed solution
4. The team reviews and approves
5. The approved change is implemented
6. **The next audit verifies whether it improved the result**

## The intended outcome

Not another dashboard. It should function like a senior systems analyst, a lead-journey specialist,
a marketer and a copywriter working together to answer: **where is this account losing commercial
value, what is creating that leak, what should we change, and how will we know whether the change
worked?**

Over time every account builds a documented history of findings, tests, changes and results. That
improves individual accounts and teaches us which strategies work consistently across the agency.

---

## Where the code stands against this spec (2026-07-27)

| Spec element | Code | State |
|---|---|---|
| Normalised account evidence | `lib/measurement.mjs`, `lib/observations.mjs`, `lib/adapters/*` | **built, live-verified** |
| Journey reconstruction | `lib/journey-projection.mjs`, `lib/evidence-graph.mjs` | **built** |
| Largest-leak identification | `lib/metrics.mjs` + metric contracts | **built** |
| Follow leads past the week | the maturity ladder, 30/60, 60/90, 90/180 | **built** |
| Period-over-period comparison | `previousClosedWeek` window + `diff` | window built, diff undriven |
| Lane 1 journey/KPI analysis | — | brief buildable, analysis undriven |
| Lane 2 workflow config **and execution** | config collected; runtime windows OPT-IN and never run | **half built** |
| Lane 3 conversation/copy/AI | copy and AI configs reachable; 26 email bodies live in library templates, unfetched | **half built** |
| **Root-cause investigation** | `analyzer.discover` / `falsify` are stubs | **NOT BUILT. The missing keystone.** |
| Weekly account report | `lib/report.mjs` | built, receives nothing |
| Implementation-ready solution packages | `lib/proposals.mjs`, solution types `workflow_logic`, `copy`, `wait_timing`, `conversation_ai`, `voice_ai`, `operating_process` | built, receives nothing |
| Prioritised backlog | `lib/memory.mjs` `projectBacklog` | built, receives nothing |
| Approval and verification loop | memory events `approval_receipt`, `implementation_receipt`, `verification_result`, `finding_transition`, `waiver_recorded` | built, undriven |

The machinery for almost every box exists. What is missing is the investigation that turns evidence
into findings, and the wiring that carries findings into the three outputs.

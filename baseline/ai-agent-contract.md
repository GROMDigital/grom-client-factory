# AI Agent Contract (Tier-1)

The AI is not adjacent to the build, it is inside it. `03 - Booking Started + Chase`
is triggered by the booking agent's own flow, and `12 - AI Escalation + Human
Takeover` triggers on the exact tags GHL's handover action writes. So agent
config is a build contract, not a per-client preference.

**New 2026-07-26 (the Standard Build).** Applies to NEW builds. Existing clients
(Francesca, SK Skin, Alevere) do not migrate. Read with
`baseline/canonical-model.md` (the tags and custom values named here) and
`baseline/base-workflows.md` (03, 12 and the removal matrix).

Every requirement below has a live failure behind it. None of them are
preferences.

## 1. The agent set

| Agent | Present | Job |
|---|---|---|
| Primary chat | always | answers everything, qualifies, hands off |
| Booking chat | always | owns the booking conversation only |
| Voice inbound | voice clients only | answers the tracked number |
| Voice outbound | voice clients only | `40 - Speed-to-Lead Outbound Call` |

**The chat side is always two agents, not one.** The booking agent is a
flow-builder bot (§2) and the primary is a prompt bot; they cannot be the same
object. Multi-calendar chat also degrades the treatment conversation, which is
why chat splits by agent while voice (which cannot swap agent mid-call) uses one
agent with multiple calendars.

Only ONE agent can be primary, and **only the primary replies to inbound
messages**. Everything else in this file is irrelevant if the wrong one holds it.

## 2. The booking agent MUST be a flow-builder bot

Not a preference, and not a performance judgement. It is the only way the
Standard Build's third stage can exist.

"The booking AI presented dates" is not an observable GHL event. There is no
outbound-message trigger, no "AI sent a message" trigger, and no availability
event. The Conversation AI action enum is closed (`triggerWorkflow`,
`updateContactField`, `appointmentBooking`, `stopBot`, `humanHandOver`,
`advancedFollowup`, `transferBot`) and none of them emits "I offered times".

A flow bot's logic IS a workflow. So an `add_contact_tag` step placed immediately
BEFORE the booking node writes `booking:availability-shown` deterministically, by
graph position rather than by LLM judgement.

🔴 **The tag goes BEFORE the booking node, never after.** The booking node
branches only `onBooked` and `onNotBooked`; "slots presented" is not one of its
branches, so a tag placed after can only ever describe an outcome.

The ConvAI `triggerWorkflow` action would also fire, and is live on Grom's own AU
booking agent, but it is LLM-judged against a prose condition. Prompt-judged
correctness has already failed on this estate: every Francesca fix that landed was
a config flag or a workflow step, and every fix attempted through prompt wording
failed, with both bots observed violating their own explicit prompt rules
verbatim.

### The four conditions, or the bot is silent with no error anywhere

All four, or nothing happens and nothing is logged:

1. Agent channel is `Live_Chat`.
2. Mode is auto-pilot.
3. The agent is set as **PRIMARY**.
4. 🔴 The attached chat widget's **`Chat type` MATCHES the agent's channel.**

**Widget NAMES are meaningless. Read the `Chat type` column.** On AU, "Chat Widget
1" was a Voice AI widget and "Chat widget 2" was SMS/Email; neither was Live Chat,
and one had to be changed before the bot would answer. Widget chat type lives in
the widget's own settings (Sites, then Chat Widget), not in the funnel.

🔴 **`isPrimary` cannot be set by API.** The merge PUT on
`/ai-employees/employees/:id` returns 200 and does nothing. Setting primary is a
manual UI step, and it belongs on the go-live checklist rather than in a build
script.

The page hosting the widget must be a UI-built, PUBLISHED funnel page with real
content.

## 3. Hard requirements

| Requirement | The live failure it prevents |
|---|---|
| Booking agent is a flow-builder bot | "showed availability" is otherwise undetectable, so stage 3 cannot exist |
| `add_contact_tag` immediately BEFORE the booking node | the only deterministic Booking Started signal |
| `knowledgeBaseIds` non-empty | Grom's own UK booking agent auto-piloted the money moment with none |
| `calendarIds` non-empty on every booking action | all four SK voice actions were empty, so reschedule never worked |
| cancel and reschedule enabled at ACTION level | agent-level flags are vestigial (§5) |
| `sleepEnabled: true` | Francesca's treatment agent talked over staff who joined the thread |
| `autoPilotMaxMessages: 12` | the default is 100 |
| one `updateContactField` action per captured fact | the booking AI otherwise captures nothing (§4) |

## 4. What the AI can and cannot write

🔴 **A Conversation AI agent CANNOT write an opportunity field.** Its only
field-write capability is `updateContactField`, keyed to a contact field ID. There
is no opportunity-field writer in the action enum.

So every AI-captured per-cycle fact lands on a CONTACT field named `stg_<field>`,
declared write-only, and the workflow that attaches the card (01 or 03) copies it
one-way onto the opportunity. Nothing else reads the staging field. This is the
single sanctioned exception to the no-mirror rule in `canonical-model.md` §7.

`objective.contactField` takes the field **ID**, not the field key.

**The handover tags are platform-emitted, not invented.** `ai:human-takeover` and
`ai:cancel-requested` are the exact spellings GHL's own `humanHandOver` actions
write. `12` triggers on them, so a respelling silently disconnects escalation
from the AI entirely.

**Silencing the AI is `update_conversation_ai_status` (`status: inactive`), not a
tag.** Francesca shipped the tag approach and it was inoperative: `ai:off` did not
silence the bot. `ai:off` remains a flag for humans and for reporting; it is not a
kill switch.

## 5. Capability flags live on the ACTION, not the agent

The agent document carries `cancelEnabled` and `rescheduleEnabled` too. **They are
vestigial and govern nothing.** Francesca's agent read `rescheduleEnabled: false`
while the AI was demonstrably rescheduling in production, because the ACTION said
true. The action wins.

🔴 **A capability flag overrides prompt text.** With `cancelEnabled: true` the bot
cancels for real even when the prompt says "You cannot and do not cancel
appointments." Prompt wording controls HOW it cancels, never WHETHER. So every
capability the client must not have is turned off at the action, not argued with
in the prompt.

🔴 **The employee PUT does not purely merge.** Sending `{instructions}` alone
silently reset agent-level `cancelEnabled`. Re-read after every employee write and
re-assert. Action objects are separate and survive employee PUTs.

## 6. Personas and shared strings come from custom values

Agent prompts DO interpolate `{{ custom_values.* }}`, proven live on both chat and
voice. Use the exact `fieldKey` form the API returns, spaces included:
`{{ custom_values.ai_primary_name }}`.

So the persona name, business name, phone, address and booking URL are written
ONCE as custom values (`canonical-model.md` §8) and referenced from every agent
prompt. Hardcoding the persona across five agents turns a rename into five
full-replace prompt writes; with the tag it is one custom-value write.

## 7. Flow-bot node requirements

Seven of the nine `conversationai_*` node types have builder-required fields.
Omit one and the node carries a red error badge and the bot cannot be published,
while the build pipeline reports clean. The engine now enforces this
(`required-fields.mjs`, plugin 0.16.0), and the design must still declare the
values because the engine hard-errors rather than inventing them.

| Node | Required |
|---|---|
| `ai_message`, `custom_message` | `waitForReply` (presence; `false` is a valid value) |
| `transfer_bot` | `assignedEmployeeId` |
| `ai_splitter` | `description` |
| `book_appointment` | `calendarId` |
| `end` | `sleepEnabled` |
| `services_booking` | `conversationai_services`, `conversationai_booking_description` |

Clean with no required fields: `objective` (just `objective`) and `continue`
(literally `{}`).

🔴 **`conversationai_end`'s documented keys were wrong.** The real shape is
`{message, sleepEnabled, sleepDuration, sleepUnit}`, not
`customMessage`/`reactivate`/`duration`. An unknown key persists silently while
the actually-required field stays unset.

⚠️ **`services_booking` is unusable on an account with no commerce services**
(its options endpoint returns an empty list). Treat as opt-in with a services
precondition; do not put it in a default build.

## 8. Voice AI (voice clients only)

- **`agentSettings` is not writable by API** (response speed, interruption
  sensitivity, voicemail). All three routes 422. These are UI-only settings and
  belong on the go-live checklist.
- **The agent PUT is an allow-list, not a full replace.** Echoing a GET body back
  is rejected.
- **Actions have their own endpoints** and are the only way to change booking
  behaviour. Creating an action with `agentId` in the body auto-links it.
- **Multi-calendar is voice's only routing path**, since voice cannot swap agent
  mid-call. `calendarIds` is an array of objects, each with its own trigger
  condition, plus a fallback calendar.
- 🔴 **The public API cannot read multi-calendar back.** It projects sometimes as
  `null` and sometimes as a concrete primary id, and neither is evidence of
  single-calendar mode. Verify in the builder UI or the internal GET, never by
  round-tripping the public API. Do not build an audit finding on that read.
- **Voice has no draft/publish split.** Saving an action is publishing it.

## 9. Testing contract

🔴 **There is no sandbox for flow bots.** GHL's own trial panel says the
flow-builder trial is broken and to test live with a real contact. So every flow
bot is validated by a controlled live test: a real contact receiving real
messages, on a number or inbox the build team owns, bot switched off immediately
after, and the test contact plus any opportunity it created deleted.

Budget that test into every build. A flow bot that has only been verified at
build time has not been verified.

Live chat testing wakes the bot only through a genuinely inbound message.
API-injected inbound does not.

## 10. Reporting hook

Appointments booked by AI are distinguishable: GHL stamps `createdBy.source` as
`voice_ai` or `conversations_ai`. Per-AI booking attribution depends on it, so no
build may route an AI booking through a mechanism that loses the stamp.

## 11. What the validator asserts

| Check | Why |
|---|---|
| booking agent `botType` is the flow-builder type | stage 3 cannot exist otherwise |
| an `add_contact_tag` writing `booking:availability-shown` precedes the booking node | the Booking Started signal |
| `knowledgeBaseIds` non-empty | the money moment with no knowledge base |
| `calendarIds` non-empty on every booking action | reschedule silently never worked |
| `autoPilotMaxMessages` set | default 100 |
| every flow-bot node carries its required fields | red error badge, cannot publish, build reports clean |
| every AI-captured per-cycle fact has a `stg_` contact field AND a copying step | the AI cannot write the card directly |
| handover tags spelled exactly as the platform emits them | 12 silently never fires |

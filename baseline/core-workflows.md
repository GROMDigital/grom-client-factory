# Core-Six Workflows (Tier-2 defaults)

The median clinic's automation spine. Adapt freely per strategy; record
divergences. Flat chronological naming: `01 Name` .. `NN Name`, no folders.
Every internal/client notification is an embedded step in its workflow.

## Standard funnel shape (always includes a landing page)
Every Grom funnel is: Meta Ad -> Meta Lead Form -> redirect to a booking/deposit
landing page -> book and pay the deposit. The landing page is the booking surface
and where the LP events fire. Assume at least one landing page per funnel or offer;
`no_lps` is true only when a build has no booking page at all, which is rare and
must be justified in the registry.

## 01 Meta Lead Capture + Nurture
Trigger: FB Lead Form Submitted (one trigger per form). Goals end nurture on
reply/booking. Stamp fields + `funnel:<slug>` tag, create opportunity, internal
new-lead alert, instant first SMS inside send window, then a multi-day SMS +
email ladder ending `nurture:exhausted`.

## 02 AI Reply / Remove From Nurture
Trigger: Customer Replied (any channel). Guarded once per contact: move stage
New Lead -> Conversation Started, remove from nurture ladders, wake the primary
conversation AI, internal engaged alert. Silent to the lead.

## 03 Missed Call Text-Back
Trigger: missed inbound call on the tracked number. One SMS, max once per 24h
(`missed-call:cooldown` tag), reply wakes the primary AI.

## 04 Appointment Booked + Reminders
Trigger: Appointment Confirmed on the booking calendar. Kill nurture and speed
workflows (never the deposit workflow if one exists). Confirmation SMS + email,
reminder ladder anchored to the appointment: ~3 days, day-before YES/NO
confirmation ask (alert on wobble/silence), morning-of with an 08:30 floor,
1 hour before. Embedded clinic alerts.

## 05 Appointment Reschedule + Reminders
Trigger: Appointment Confirmed AND rescheduled = Yes. Remove 04's instance,
reset appointment tags, new-time confirmation, identical ladder restarted
against the new time. Internal reschedule alert.

## 06 Appointment Cancellation Recovery
Trigger: enrolled by the booking AI / human on an insisted cancel (not raw
calendar status). Remove 04/05, stage regression, team ACTION alert (a human
cancels in the calendar), guarded multi-day win-back, ends Lost with reason.

Common extensions seen in real builds (design when strategy demands): deposit
link send + chase, deposit-paid handler, unpaid-slot guard, speed-to-lead
outbound call + wrap, engaged/details stage syncs, escalation handler, human
takeover switch (`ai:off`), long-term nurture, no-show outcome sync.

# Go-Live Checklist (template)

Instantiated per client by the Go-Live Checklist Compiler with owners, dates,
and client specifics. Steps that depend on a wait are marked GATED-BY.

## 0. CRITICAL PATH, submit on day 1 (these cook while you build)
- [ ] Compliance/registration bundles submitted (regulatory, address, business
      docs). WAIT: days to weeks. Owner: Grom. GATES: all SMS sends, SMS smoke
      tests, voice caller ID.
- [ ] Phone number purchased + configured in the sub-account. GATES: missed-call
      text-back, voice AI, tracked-number anything.
- [ ] Email sending domain created; DKIM/SPF/DMARC records handed to whoever
      controls DNS. WAIT: DNS propagation + warm-up. GATES: email sends.
- [ ] LP subdomain DNS records requested. WAIT: propagation. GATES: LP publish,
      tracking verify, pixel verify.
- [ ] Payment processor connected (if deposits/payments). GATES: payment links,
      deposit workflows, product-filtered automations.
- [ ] Meta pixel created/confirmed + ad account access confirmed. GATES: pixel
      install verify, CAPI events.

## 1. Business setup and compliance
Business documents uploaded; bundles submitted/approved; phone purchased and
configured; owner + client-approved users created; sub-account timezone set;
business hours set; custom values populated.

## 2. Domain, email and technical
Sending domain authenticated; LP subdomain authenticated; client calendar
connected; calendar hours/buffers/booking rules match client answers; payment
setup confirmed if required.

## 3. Strategy and research
Deep research done; ICA defined/reviewed; messaging aligned to offer + voice;
lead journey strategized ad-click -> booking; workflows, AI conversations,
appointment flow, notifications mapped (the design doc set IS this section's
evidence).

## 4. Pipeline
Pipeline(s) created per design; stage -> canonical-step map recorded in the
manifest; movement tested for: new lead, reply, booked, reschedule, cancel,
no-show, showed.

## 5. Core workflows
Each designed workflow built and published. Per workflow verify: trigger,
messaging vs canonical copy, waits, tags/fields/stage moves, exits, embedded
notifications.

## 6. AI voice
Agents configured per design (objective, flow, cadence, personality, KB,
booking calendar, objections). GATED-BY: phone + compliance. Test calls end to
end before go-live.

## 7. Conversational AI
Primary + booking agents per design; KB pasted; booking into correct calendar;
workflow enrollments wired; test paths: interested, price shopper, not ready,
wants info, wants booking, reschedule, no response.

## 8. Landing pages and thank-you pages
Built outside the factory (directly with the user); copy/brand verified; forms,
calendars, CTAs working; full lead + booking flow tested; mobile responsive;
page speed sane. Reconciled to the tracking design by the
`grom-client-factory:reconcile-lp-tracking` skill (five events, selectors,
snippet, CSP) before this line is checked. HEAD-PASTE WARNING: paste ADDS, check
existing head content first.

## 9. Tracking and analytics
First-party snippet live on every LP (page-level paste); booking steps firing;
Clarity project live; pixel PageView on the designed pages only; CAPI events
mapped; events verified end to end against the tracking repo checklist.
GATED-BY: DNS + LP publish.

## 10. Dashboards
Internal dashboard instance provisioned; Meta + GHL + LP data flowing; client
portal rows created; client-facing visibility configured; numbers spot-checked
against source systems. See post-launch runbook for step labels.

## 11. Notifications
Verified EMBEDDED in their workflows (never standalone); internal + client
recipients confirmed against the alert catalog.

## 12. External dependencies
Each external system (booking/CRM/forms/payments) identified, access confirmed,
permission confirmed, connections to GHL/LPs/tracking/automations tested.

## 13. Grom-side account provisioning
Staff calendar user created first; notify recipients configured; snapshot
cleanup done per the registry disposition list (brownfield).

## 14. Baseline retro (close the loop)
Review the divergence log in 00-build-overview; promote repeated divergences to
baseline defaults or retire stale ones; record in baseline/CHANGELOG.md.

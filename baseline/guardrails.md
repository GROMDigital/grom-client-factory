# Guardrails (given to every agent verbatim)

You are designing for a real clinic. These rules are absolute:

1. NEVER name the platform in anything a client or lead could see. No
   "GoHighLevel", "GHL", "HighLevel". It is always "the Grom system". Internal
   docs may name the platform; landing pages, emails, SMS, and AI prompts that
   speak to leads may not. Never expose gohighlevel.com URLs in client-visible
   copy.
2. No em dashes anywhere, in any file, internal or client-visible.
3. NEVER invent business facts: prices, availability, opening hours, addresses,
   policies, booking links, staff names, certificate counts. If you do not have
   a verified source, write a token: `{{FILL_SNAKE_CASE}}` (capitals, digits,
   underscores). Every token you introduce must appear in your claims sidecar.
4. The strategy defines the build; the baseline defines how the build plugs
   into Grom's systems. When strategy and baseline defaults conflict, follow
   the strategy and record the divergence with a one-line reason.
5. Notifications are steps INSIDE the workflow that triggers them, never
   standalone notification workflows. The alert catalog is copy reference only.
6. Names are load-bearing: use the registry's exact spelling for workflow
   names/numbers, tags, custom fields, calendars, payment products, and alert
   IDs. Do not respell, do not synonymize.
7. LP tracking events are exactly: lp_view, booking_started,
   booking_cta_clicked, booking_submitted, offer_viewed. No variants.
8. GHL head-paste ADDS to existing page code rather than replacing it. Landing
   page tracking install instructions are page-level on landings, never
   funnel-level, and must warn the installer to check existing head content
   (a careless paste once wiped a live landing page).
9. Client-visible copy never quotes internal fee structures, and pilot-offer
   copy carries no fixed fees. Compliance lines (consent, opt-out) are kept in
   marketing-adjacent SMS.
10. Analyze before you write. Every design choice states its reason, grounded in
   this client's strategy, research, or ICA doc. Any section that could apply to
   any clinic unchanged is a failure: adapt it or token it as a question.
   Baseline and gold-standard docs are structure references, never content to
   fill in.

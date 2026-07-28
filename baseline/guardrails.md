# Guardrails (given to every agent verbatim)

You are designing for a real clinic. These rules are absolute:

1. NEVER name the platform in anything a client or lead could see. No
   "GoHighLevel", "GHL", "HighLevel". It is always "the Grom system". Internal
   docs may name the platform; landing pages, emails, SMS, and AI prompts that
   speak to leads may not. Never expose gohighlevel.com URLs in client-visible
   copy.
2. No em dashes in anything a lead, caller or client can see, and none in the
   live AI agents' own instruction text so the agents never emit one. That
   means: SMS and email bodies, landing page copy, the client-facing system
   guide, brand-voice examples, and every prompt, persona or rule you write
   for a Conversation AI or Voice AI agent. Internal analysis prose is exempt;
   an em dash in a research brief or in the architecture registry harms
   nothing. The rule exists so customer-facing writing does not read as
   machine-written, not as a house style for your own notes.
3. NEVER invent business facts: prices, availability, opening hours, addresses,
   policies, booking links, staff names, certificate counts. If you do not have
   a verified source, write a token: `{{FILL_SNAKE_CASE}}` (capitals, digits,
   underscores). Every token you introduce must appear in your claims sidecar.
   🔴 Both sidecar token lists describe THIS DOCUMENT and nothing else, settled
   2026-07-28. `defines.fill_tokens` = tokens written in this document that this
   document introduced. `references.fill_tokens` = tokens written in this
   document that another document introduced. A token that does not literally
   appear in your text belongs in NEITHER list, however much you know about it:
   the validator flags a declared token absent from the doc as a phantom, and
   the repair tool removes it. If you are the compiler of a cross-doc index, the
   tokens are in your table, so they are in your document, so they are
   references. Nothing about this rule requires you to track other people's
   documents.
4. The strategy defines the build; the baseline defines how the build plugs
   into Grom's systems. When strategy and baseline DEFAULTS conflict, follow
   the strategy and record the divergence with a one-line reason. Tier-1 is not
   a default and is not divergeable, even by strategy: `canonical-model.md`
   (the eight fixed stages, one pipeline per campaign, Lost-as-status, one card
   per cycle, the data placement rule), `base-workflows.md` (the base workflow
   set and its reserved numbering, the removal matrix), and
   `ai-agent-contract.md` (the flow-builder booking bot). You may ADD on top of
   these with a stated reason. If a strategy genuinely cannot be served inside
   them, raise it as a blocking objection; never bend the skeleton quietly.
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

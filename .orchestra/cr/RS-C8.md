Title: CR-C8-RS8: dashboard API has no counts for 5 of the 7 pipeline stages and no per-role "needs you" feed
From chunk: C8 (RS-C8 web restyle)            To owner: C8 (analytics API, GET /v1/analytics/dashboard)
Type: api
Blocking? no (RS-C8 ships with label-only stages; LD-140 forbids new data in a restyle)
Problem: 10-DESIGN-SYSTEM s4 asks for one pipeline stepper (Draft, To collect, To receive, In progress, To authorise, Authorised, Released) where each count is a filter, and a "needs you" list per role. The dashboard DTO `tiles` only gives sources for In progress (`pending_tests`) and Authorised (`results_approved`) (RS-C8-ruling.md). Draft, To collect, To receive, To authorise and Released have no count, so they render as labels only. "Needs you" is built from `pending_overdue`, `reports_ready_unreleased`, `reports_pending`; there is no role-specific action feed.
Proposed change (exact): owner to name and add, in the dashboard contract (03-INTERFACE-CATALOG / OpenAPI), one count per missing stage, scoped like the existing tiles, plus (optional) a per-role actionable list. Names are NOT proposed here (CLAUDE.md: never invent a name).
Backward compatible? yes (additive fields)
Tenant/security impact: same RLS/centre scope as the existing tiles; no PHI (counts only).
IRD/regulatory impact: none.
Alternatives considered: invent counts client-side (rejected: LD-140 no new data); show 0 (rejected: invented 0, RS-C8 test contract).
Tests that will prove it: rs-c8.dashboard pipeline tests extended so every stage with a sent count is a link to an existing analytics page.

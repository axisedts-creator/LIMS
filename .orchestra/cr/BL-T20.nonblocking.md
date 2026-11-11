Title: CR-C4-BL20: shell data the billing screens need (non-blocking)
From chunk: C4 (BL-T20)   To owner: C0-0D (web shell) / C4 contracts
Type: shared-lib
Blocking? no — screens degrade (documented below).
Problem / proposed change (exact):
1. `ShellSession.actor.membershipId` (apps/web/src/core/session/types.ts): worklist needs it to mark own refund requests ("Needs another approver"). Until then page passes '' (UI hint off; API still forbids self-approval).
2. Centres in scope for InvoicesList/DuesList filters (same as CR-C7-WEB-T02-b). Until then Centre filter has no options.
3. CBMS client mode is not exposed by any billing API; `/billing/cbms` hard-codes mode='stub'. Propose `mode: stub|live` on `listCbmsDocuments` response or on BillingSettings.
4. apps/web devDependencies for tests (msw, jsdom, axe-core, @testing-library/*) — see CR-C7-WEB-T02-a.
Backward compatible? yes (additive).
Tenant/security impact: none.
Tests that will prove it: BL-T20 page tests once the session carries the fields.

# T0D-FIX-7 impl (writer)
- Changed: `services/api/src/modules/payments/handlers/intents.ts` csv() only — accepts comma string OR array of strings; same allowed lists, dedupe, 20-item cap after dedupe; empty string / empty array / non-string items = 400. Covers status, gateway, hold_reason. Cites LD-455.
- [CONV] Audit in payments.yaml: array+form+explode:false only on listPaymentIntents and listPaymentRefunds status/gateway; refunds (refund.service.ts:64) already took both. No other payments handler changed. Web query matches contract, no web edit.
- Tests: fix7.list-array-query.test.ts 37/37 pass; api tsc 0 errors.
- Open: full `src/modules/payments` run = 201 failures in merchant/reconciliation/staticqr integration + unit/manifest (auth.unauthenticated, "worksheet must not call ports", PHASE_STUBS). Those files do not use csv(), so the failures look like they came before this change, but no baseline run proves it. Web `src/features/payments` run fails on module resolution (`@/core/i18n/messages`, `@/core/api/server-fetch`), which points at the environment/config, not this diff.
- Outside payments: see T0D-FIX-7-left.md.

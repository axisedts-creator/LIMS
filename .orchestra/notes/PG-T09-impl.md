# PG-T09 impl (writer)
- Files: `service/callback.service.ts` (resolver + P30-P33 pipeline), `handlers/{launchEsewaPayment,esewaSuccessCallback,esewaFailureCallback,khaltiReturnCallback,getPaymentResultPage}.ts`, `pages/{resultPage,launchPage}.ts`. `handlers/index.ts` untouched (placeholders stay 503 until the runtime supplies deps; P34 needs none, wire it with the rest).
- Tests: payments suite 1114 pass, 2 fail: `manifest.test.ts` PHASE_STUBS (pre-existing on main) and AC-PG-14.2 (test bug: `t.callbacks(B)` passes a UUID, helper wants 'A'|'B' -> `PG-T09-dispute.md`; proven with a scratch test).
- [CONV] step 4 to_pending is done by applyCheck's own PENDING mapping (cause `callback`), not a separate update; a failure callback + NOT_FOUND therefore stays `initiated` (AC-PG-03.8).
- [CONV] `held_for_review`/`created` intents: row written, no gateway call, no state change (finance resolves holds); terminal intents -> `payments.callback_stale`, no check.
- [CONV] eSewa mismatch of transaction_uuid/product_code -> `payments.callback_mismatch` (signature_valid=false); stored query keeps only transaction_code/status/total_amount/transaction_uuid/product_code (never `data`, `signature`, Khalti `mobile`).
- [CONV] applyCheck runs in mode `reconciliation` (no 10 s min interval; the per-intent throttle is the limiter); error -> poll job key `poll:<id>:cb:<minute>`, payload n=0.
- Open: CR in `.orchestra/cr/PG-T09.md` (limiter prefix `payments:cb:`; resolver-undefined -> 303 vs auth.unauthenticated). Not run: lint (no script found for this lane), real DB/RLS/DEFINER.

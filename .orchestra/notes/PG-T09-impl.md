# PG-T09 impl (writer)
- Files: `service/callback.service.ts` (resolver + P30-P33 pipeline), `handlers/{launchEsewaPayment,esewaSuccessCallback,esewaFailureCallback,khaltiReturnCallback,getPaymentResultPage}.ts`, `pages/{resultPage,launchPage}.ts`. `handlers/index.ts` untouched (placeholders stay 503 until the runtime supplies deps; P34 needs none, wire it with the rest).
- Tests (after ruling/029e28ef, no impl change needed): verify set 166/166 pass; payments+ratelimit 1481 pass, 1 fail = pre-existing `manifest.test.ts` PHASE_STUBS (main). tsc: no errors in payments/ratelimit.
- [CONV] step 4 to_pending is done by applyCheck's own PENDING mapping (cause `callback`), not a separate update; a failure callback + NOT_FOUND therefore stays `initiated` (AC-PG-03.8).
- [CONV] `held_for_review`/`created` intents: row written, no gateway call, no state change (finance resolves holds); terminal intents -> `payments.callback_stale`, no check.
- [CONV] eSewa mismatch of transaction_uuid/product_code -> `payments.callback_mismatch` (signature_valid=false); stored query keeps only transaction_code/status/total_amount/transaction_uuid/product_code (never `data`, `signature`, Khalti `mobile`).
- [CONV] applyCheck runs in mode `reconciliation` (no 10 s min interval; the per-intent throttle is the limiter); error -> poll job key `poll:<id>:cb:<minute>`, payload n=0.
- [CONV] LD-121: `core/ratelimit/index.ts` tier `general` accepts `payments:cb:<non-empty id>` via the `u:` bucket (10/s, burst 20); rest unchanged.
- Open: CR in `.orchestra/cr/PG-T09.md` (limiter prefix `payments:cb:`; resolver-undefined -> 303 vs auth.unauthenticated). Not run: lint (no script found for this lane), real DB/RLS/DEFINER.

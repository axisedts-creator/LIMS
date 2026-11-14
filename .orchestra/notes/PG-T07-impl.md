# PG-T07 impl (writer)
- Files: `gateways/khalti.adapter.ts` (createKhaltiAdapter: initiate, buildAction, check; exports CallContext/IntentForGateway/StoredIntent/GatewayCheck types), `gateways/fonepay.adapter.ts` (createFonepayAdapter: all methods -> payments.gateway_not_available).
- Tests: khalti + fonepay adapter suites 61/61 pass; full `src/modules/payments` 699 pass, 22 skipped (pre-existing live/integration); tsc: no errors in the two new files (repo-wide tsc has pre-existing errors in contracts/ and packages/).
- [CONV] seams follow tester's header: initiate(i,secret,c?) / buildAction(i,secret) / check(i,secret,c?); check default timeoutClass = 'inrequest'; reuses callGateway + assertAmountSupported('khalti').
- [CONV] total_amount trusted only if positive safe integer; statusRaw passed through uncapped (mapping handles unknown); refundedFlag always boolean.
- Open: TRD §7.3.2 says log Khalti `error_key` on initiate failure; not logged (log fields are allowlisted in http.ts, no error_key slot) — decide in a later task.
- Open: types live in khalti.adapter.ts (no GatewayAdapter.ts owner in plan); move when eSewa adapter lands.

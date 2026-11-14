# PG-T10 tests (tester)
- File: services/api/src/modules/payments/events/__tests__/publish.test.ts (real core createEvents({producer:'payments'}) + in-memory tx fake; real envelope + contracts/events schema).
- Run: `.orchestra\notes\PG-T10-verify.cmd` (= pnpm --dir services/api exec vitest run src/modules/payments/events/__tests__).
- Covers: schema contract (required/invalid/extra keys fail closed), key `<gateway>:<ref>:settled`, aggregate payment_intent/seq=version, duplicate -> one event (incl. concurrent, replay with new ledger id), rollback -> no event (AC-PG-06.1/.2/.4; .3 only via PG-T08).
- Writer SEAM (../publish.ts): exports `SETTLED_EVENT`, `settledIdempotencyKey(p)`, `createPaymentsEvents(eventsPort).intentSettled(ctx, payload, { intentVersion })` -> core publish result. Payload passes through verbatim (no adds, no strips).
- Not tested here: outcome.service still calls deps.events.publish directly (PG-T08); wiring it through this publisher is optional, no test forces it.
- Expected now: suite fails to load, `../publish.js` does not exist.

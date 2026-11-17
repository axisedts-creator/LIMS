APPROVE

PG-T10 review (diff 3b92479d..HEAD: publish.ts, publish.test.ts, notes).
- Names verbatim: `payments.intent.settled.v1`, aggregate `payment_intent` seq = intent version, key `<gateway>:<gateway_txn_ref>:settled` (03-IC §3.20).
- Payload validation delegated to core publish against existing `contracts/events/payments.intent.settled.v1.schema.json` (additionalProperties:false, fails closed `common.internal`); tests cover missing/invalid/out-of-schema keys (no secrets/PII carried).
- No tables/RLS/routes/permissions/rate tier in scope; no logging, no secrets; only owned paths (services/api/src/modules/payments/events/*).
- Tests: contract, idempotency key, duplicate settle -> one event (incl. concurrent), rollback leaves no event (AC-PG-06.1/.2/.4; .3 held path belongs to PG-T08). Ran verify cmd: 40/40 pass. tsc: no errors in these files.

APPROVE

PG-T08 review (reviewer), diff ed0d6940..HEAD.
- Checked: TRD §5.3 (signatures, per-method error codes, actor guard user/system -> auth.forbidden), §6.1 steps 1-12 (order, fingerprint, ON CONFLICT -> re-read / intent_open_exists, poll job keys `poll:<id>:<n>`), §6.2 (min interval, lock + decide on current status, exceeds_due, settle -> recordGatewayPayment + `payments.intent.settled.v1` with key `<gateway>:<ref>:settled`, aggregate `payment_intent`, seq = version), §6.4 cancel (`abandoned`, reason_code on transition). Names match 05-SCHEMA (hold/failure reasons, transition causes, verification_method, intents__settled__ck) and 03-IC §3.20 payload.
- Tenant: every SQL statement filters `tenant_id = ctx.tenantId`. No DDL/RLS in this diff (C0). No PHI or secrets in logs (ids only). Paths owned.
- Run: `vitest run src/modules/payments` -> 1013 pass / 8 skip / 0 fail. tsc: 0 errors under modules/payments.
- Accepted [CONV]s: ledger call before the settle UPDATE (needed by intents__settled__ck, same tx); eSewa unknown status holds at once (03-IC §4.9 case 5 outranks TRD §7.2.4); verify skips gateway on settled family.
- Non-blocking notes: cancelIntent can throw `payments.gateway_not_available` (via applyCheck) when the account was disabled after creation — not in TRD §5.3 cancel row; spec is silent, leave for lead. Metrics (PG-T20), true DB parallelism (C0 DDL), and the eSewa token-replay CR (.orchestra/cr/PG-T08.nonblocking.md) remain open.

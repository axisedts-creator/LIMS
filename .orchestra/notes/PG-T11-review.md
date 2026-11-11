APPROVE

PG-T11 review (diff 82430ff1..HEAD)
- Names verbatim from TRD §8.3: `payments.poll_intent` (task, max_attempts 8), `payments.sweep_open_intents` (cron `*/15 * * * *`, per_tenant, max_attempts 3); payload `{tenant_id, intent_id, n}`. Nothing invented.
- poll: applyCheck with cause `poll`; terminal statuses are no-ops (no gateway call, write or enqueue); `retry` throws so the queue backs off. Payload is untrusted: tenant must equal ctx.tenantId, intent_id must be a uuidv7, and the lookup is tenant-scoped. Amount and status in the payload are ignored.
- sweep: deadline = expires_at + grace < now and no check in the last 15 min. Enqueues "poll now" with a stable key per intent. Explicit tenant_id predicate on top of RLS; no writes, no gateway calls.
- No migrations, so no RLS changes. No logging, no PHI, no secrets. Only C15 paths touched (worker jobs/payments plus additive edits to the api payments test helpers).
- Tests: worker jobs/payments 52/52 pass; tsc shows no errors under jobs/payments. They cover AC-PG-05.1 (fake-clock schedule and mapping), 05.2 (expiry at the deadline), 05.3 (lost job recovered by the sweep within deadline + 30 min) and terminal-stops-polls.
- Deferred, not defects: the refund sweep (`check_refund`) is PG-T15 and the sweep gauges are PG-T20. `bindPaymentsRuntime` is not called by anyone yet: main.ts (C1-owned) does not register the payments manifest, and unbound jobs fail closed. The worker bootstrap must call it before go-live.
- Unrelated failure in the api suite: unit/manifest.test.ts "PHASE_STUBS no longer lists PaymentProviderPort" fails (1/1061). PG-T11 does not touch phase-stubs.ts. Track it separately.

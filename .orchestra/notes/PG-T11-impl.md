# PG-T11 impl (writer)
- Files: services/worker/src/jobs/payments/{tasks/poll_intent.ts, tasks/sweep_open_intents.ts, cron.ts}; index.ts now registers both tasks (max_attempts 8 / 3) and spreads `crontab`.
- Tests: all 5 files in payments/__tests__ pass (52/52); tsc shows no errors under jobs/payments.
- [CONV] poll: terminal (settled/failed/expired/refunded/partially_refunded) or foreign/malformed/unknown intent -> silent no-op; held_for_review is still polled (it can settle). Mode 'verify', cause 'poll'.
- [CONV] retry detection: applyCheck returns no outcome, so poll wraps the adapters' `check` and throws when no usable answer came and status is unchanged (tx rolls back, backoff retries). Open point: a PG-T08 `outcome` field on VerifyResult would be cleaner.
- [CONV] sweep: key `poll:<id>:sweep`, payload n = 0, SQL = status ANY + expires_at < now-grace, 15-min quiet filter in JS; no refunds / gauges (PG-T14 / metrics).
- [CONV] index.ts `bindPaymentsRuntime(deps, ports)`: no worker runtime supplies PaymentsDeps yet; unbound jobs throw (fail closed). Open point: worker bootstrap must call it.
- Not verified: real PG / graphile behaviour (fake DB only).

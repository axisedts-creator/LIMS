APPROVE

PG-T07 review (reviewer), diff 890fafe9..HEAD.

Checked against TRD §7.1, §7.3.1–7.3.4, §7.6, §6.1 step 10; PRD US-PG-02 AC1–4, US-PG-04 AC1–7, US-PG-12 AC1.
- Names verbatim: `payments.gateway_not_available`, `khalti_initiate`/`khalti_lookup`, `epayment/initiate/`, `epayment/lookup/`, `Authorization: Key <secret>`, GatewayCheck/IntentAction shapes match TRD §6.2 step 2 / CR-register IntentAction.
- Initiate: explicit 5-field body (no PII), amount guard before network, `pidx` ≤ 64, `payment_url` https only, `error_key` → 503; expiresAt fallback chain per §6.1 step 10.
- Lookup: stored pidx only; body status is the signal (HTTP 200 vs 400 test); safe positive integer `total_amount` only; no-status 401/404/5xx/timeout → auth_error/not_found/transient; never throws.
- Fonepay: every method → `payments.gateway_not_available`, no I/O, nothing invented (B8).
- No secrets/PHI in logs (sink/log tests incl. Khalti `mobile`); only owned paths; no DB/RLS/permission surface in this task.
- Verified: `vitest run` khalti + fonepay suites → 61/61 pass; tsc reports no errors in the two new files.

Non-blocking notes (no change required for this task):
1. `http.ts` classify() returns `service_unavailable` for HTTP ≥ 500 before checking body `status`, so a 5xx carrying a status body is retried rather than answered (TRD §7.3.3 literal). Safe direction (retry, never wrong settle); revisit in http.ts owner task if desired.
2. `error_key` is persisted in `payments.gateway_calls.response_redacted` (initiate allowlist), which covers TRD §7.3.2 "logged with error_key"; app log line stays on the §7.6 field allowlist. Writer's open item can be closed.

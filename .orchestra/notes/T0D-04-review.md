APPROVE

Scope: `git diff f1fb45a..HEAD` (T0D-04, AC-0D-3.1).
- Spec match (02-CV §4.6, 02-TRD §6.2 stages 1/3/12, PRD AC-0D-3.1): `type` = `urn:lims:error:`+code, registry title/http, `instance` = path without query (REQ-SEC-098), `request_id` UUIDv7, `errors[]` only for `common.validation_failed` with JSON-Pointer paths and registry sub-codes, unknown/unregistered/non-Error -> `500 common.internal`, `Retry-After` from thrower. Every code used (validation_failed, field_*, unknown_field, not_found, method_not_allowed, payload_too_large, unsupported_media_type, internal) exists in contracts/errors.yaml. Nothing invented.
- No leaks: message = code only, ajv messages are fixed text (no value echo), 5xx log = event/error_code/err_name only. No secrets. Response-check bypass is a WeakSet of core-built objects, so a handler cannot forge it.
- Paths: services/api/src/core/** + its __tests__ + .orchestra/notes only (C0-0D owned).
- Not in scope for this task: RLS, permissions, idempotency, rate tier (no DB/route changes).
- Tests: errors.test.ts validates bodies against the real `_common.yaml#/Problem` and errors.yaml, with response validation on and off; covers every registry code, 404/413/415/malformed JSON, fail-closed cases, leak fragments, request-id echo/replace, concurrency.
- Ran: `vitest run` (services/api) 3 times. Run 1: 714/717 (3 failed, names not captured). Runs 2–3: 717/717. Looks like a cold-start timing flake. `tsc --noEmit` clean.
- Follow-ups (not blocking): (1) a `common.rate_limited` thrown without `retryAfterSeconds` sends no `Retry-After`; the rate limiter task must set it. (2) the `[CONV]` removal of the text/plain parser breaks any future spec op that declares text/plain (none today). (3) find the source of the 3-test flake if it shows up again in CI.

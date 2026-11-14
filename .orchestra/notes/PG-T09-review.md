APPROVE
Scope: `git diff 98c5f223..HEAD` = LD-121 limiter change + arbiter-ruled test fix (handlers/service landed earlier in 01686fe0, outside this range).
- `core/ratelimit/index.ts:54-58`: matches LD-121 exactly — `general` + `payments:cb:<non-empty id>` reuses the `u:` bucket (10/s, burst 20); other tiers/prefixes keep 2-char lookup, still throw 'ratelimit: unknown tier or key prefix'; `general` sole fail-open tier; no new tier; key HMAC'd with tier (no intent id in backend key). LD-121 cited in comment.
- `limiter.test.ts` covers every LD-121 tester item: consumed under general, 429 common.rate_limited after burst, empty id / other tiers / near-miss prefixes throw, per-id buckets distinct, fail-open kept, refused key never fails open.
- `callbacks.http.test.ts`: changes are exactly ruling items l.55/520/528-530 (`'A'|'B'` keys); assertion values unchanged.
- No PHI/secrets, no spec/ edits, names verbatim (`payments:cb:`, `general`, `common.rate_limited`). Failed-resolution auth.unauthenticated follow-up correctly left untouched.
Ran: verify set (`PG-T09-verify.cmd`) 166/166 pass; `tsc --noEmit` no errors in ratelimit/payments.

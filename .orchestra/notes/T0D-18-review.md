APPROVE
Scope: git diff 85671b84..HEAD = 1 test line + orchestra notes; no implementation change.
- pipeline.integration.test.ts:271: sleep 2500 -> 4100 ms with a corrected comment, exactly per the ruling (05-SCHEMA ratelimit_hit sliding estimate, 2 s window; t+4.1 s lands >= 2 windows later, so the previous window holds 0 hits = deterministic). Every 429 / common.rate_limited / Retry-After / no-handler / no-key / no-row / metric assertion and both DELETEs (:257, :273) unchanged; rps/burst unchanged; it-level timeout 120 s fits. Nothing weakened.
- Names, RLS, permissions, idempotency, error codes, PHI/secrets: untouched in this diff. Only owned paths + orchestra notes changed.
Gap (not a code defect): the DB integration suite was still NOT run, by the writer or by this reviewer (run.sh needed approval). Before merge, run `.orchestra\notes\T0D-18-verify.cmd`. done_when ("on a real request against the dev database") is unproven until that run passes.

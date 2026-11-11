APPROVE

PG-T04 review (diff 88ca84b6..HEAD). Verified against TRD §3.2/§7.6, 05-SCHEMA payments.gateway_calls, 07-SECURITY REQ-SEC-056/098.
- Names verbatim: table/columns, operation + outcome CHECK values, allowlists (eSewa status,totalAmount(string),refId,scd,code,error_message; Khalti lookup/initiate) match TRD §7.6 / 05-SCHEMA.
- Timeouts per class (initiate/inrequest/job) via AbortController; values injected by caller (HTTP_TIMEOUT_* config wiring is a later task). Done_when met.
- Allowlisted keys only stored; re-applied in repo; 64-char raw cap; <=2048-octet JSON cap; request headers/body never stored; log keys = TRD §7.6 list only. No secrets, no PHI, synthetic data.
- Repo: single parameterised INSERT; append-only respected. RLS/grants are C0 DDL; live test covers RLS, 42501 on UPDATE/DELETE, CHECKs (skipped without DB URLs).
- Only owned paths (services/api/src/modules/payments/**, own notes). Metrics deferred to PG-T20 (plan row 32) — fine.
- Ran `.orchestra/notes/PG-T04-verify.cmd`: 3 files passed, 1 skipped; 43 passed, 5 skipped.

Non-blocking notes (not defects for this task):
1. http.ts:628/redactResponse — a gateway string containing U+0000 will make the INSERT fail (text/jsonb reject NUL, 22021/22P05) and abort the caller's tx; the sink error is swallowed at http.ts:636. Consider stripping `\u0000` in cutChars/redactResponse when the sink is wired to the repo.
2. Integration test not yet run against a real DB (needs C0 DDL + LIMS_TEST_* URLs).

# C6-T34 impl (writer) — ruling IMPLEMENTATION_WRONG applied
Files: tests/load/reporting-load.js, tests/e2e/reporting-journey.e2e.ts (both rewritten), tests/load/README.md, tests/e2e/README.md. No test files edited; no pending.json change (LD-70: no stub ops turned real).
[CONV] Spec routes only: R2 search {order_id}, R3/R4, R6 (If-Match), R7 bulk-release {ids} 200 distinct, R9 regenerations (+R17 reason), D3 {recipient_kind, channel}, O1-O3, N1-N4, Q1 {qr_token}, portal /v1/reporting/portal/ + X-Lims-Portal-Credential (link./session.), Idempotency-Key on every R op. Test-support routes per CR C6-T34 (resolved).
[CONV] Held step asserts display_status held, reporting.release_blocked_due + balance_due_paisa, dues link -> link_purpose dues, P7 balance, P3 404. Load setup throws on empty qr_tokens / <200 versions / no released reports. OTP code + session token in PHI log scan.
[CONV] render_ms = first `rendering` poll -> rendered; ready_to_rendered_ms = R9 accepted -> rendered; send_task_ms = D3 latency.
Result: node --test tests/load/C6-T34.static.test.mjs 28/28; node --check k6 script OK; tsc --strict on journey clean except missing @types/node (process).
OPEN: run.ps1 may revert tests/ edits (debug round 3/4) — lead must exempt or route to tester. k6 15-min run + compose E2E not run (no stack, CR endpoints unbuilt); done_when at 10x seed unverified.

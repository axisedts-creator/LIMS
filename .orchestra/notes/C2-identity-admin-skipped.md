# C2 plan tasks skipped

None. 06-IMPLEMENTATION-PLAN.md marks no task as blocked/deferred; all 31 plan rows (T1–T31) are in the task JSON.

Notes:
- T31 patient session kind is blocked until T1 confirms D-218 items (b)/(c); the task stays in the list, the patient part is gated inside it.
- Plan order is kept (T31 before T30, as in the plan table).
- AC ids: PRD has no AC-C2, AC-C4, AC-E2, AC-E6 — mapped to US-C2, US-C4, US-E2, US-E6. Wildcards (AC-A2*, etc.) expanded from ids present in 01-PRD.md. Non-PRD refs (AU-T13..17, 07-SECURITY, 05-DoD s3.7, S24) kept verbatim in `acs`.
- T2 "contracts permissions constant" is a C0 contract, not a task id, so `depends` is empty. Cross-lane CR needs are written into `done_when`.
- T25 handler names are not listed in the plan (only "handlers §5.10"); files entry points to 02-TRD s5.10.
- `verify` = `pnpm -s verify` (root package.json script) for code tasks; empty for T30 (doc lint, no script exists).

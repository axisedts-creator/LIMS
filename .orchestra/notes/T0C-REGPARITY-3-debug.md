# T0C-REGPARITY-3 debug (2026-11-17)
- Only failing test: lint-openapi.test.ts:477 lintRepo(ROOT) == []. Its 5 violations are all OUTSIDE this task: core.yaml Readiness.missing_env (rule 3 x2, from T0B-OPSDOC-1/LD-288) and identity.yaml role-packs (rule 4 x3, no examples; from T0B-SESSRANGE-1). Same on main (last touched 603f35724). frontdesk.yaml and regparity3/regparity2 tests: clean.
- Cause: pre-existing lint debt from other tasks, not RegistrationNumberPreview. Fix NOT applied: task brief forbids touching other schemas/files (cap 8). No code change made.
- Needs lead: new small task to add maxItems/maxLength to Readiness.missing_env and examples to the 3 identity role-packs operations; then re-run verify. Or drop lint-openapi.test.ts from this task's verify.cmd.

## Round 2 (14:24)
- Re-run fails identically: lint-openapi.test.ts:477, same 5 violations in core.yaml (Readiness.missing_env rule 3 x2) and identity.yaml (role-packs rule 4 x3). main has no fix (core/identity last touched 603f35724). frontdesk.yaml, regparity3 and regparity2 tests: green (289/290).
- No code change: out of scope (task cap, other schemas). Lead must open a small fix task for those two files or drop lint-openapi.test.ts lintRepo from this verify.

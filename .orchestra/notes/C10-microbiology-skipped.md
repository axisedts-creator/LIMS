# C10 plan tasks skipped (not in task JSON)

- T-27 — integration gate: needs real C5 (`submitModuleResult`), real C6 micro section, C7 synthetic replay, and staging (e2e of 02-TRD §14). Deferred to the wave-2 integration milestone; fakes stay until then.

Notes:
- No plan task is explicitly marked blocked/deferred; B2-type blockers appear only as risks (§5), handled by the manual workflow.
- External prerequisites (C0 contracts for T-01, C0-0D `ctx.uploads`/`ctx.storage` for T-11, C0 view for T-17) are written into `done_when` as "Prereq:", not in `depends` (task ids only).
- Wildcard ACs expanded using ids in 01-PRD.md. T-25/T-26 have no AC ids (plan cites 07-SECURITY §5 / 05-DoD §3.8). T-26 `verify` empty (doc check).

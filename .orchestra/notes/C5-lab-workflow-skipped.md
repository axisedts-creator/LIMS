# C5 plan tasks skipped (not in task JSON)

None. 06-IMPLEMENTATION-PLAN.md marks no task blocked or deferred (no B4 etc.); all T-01..T-34 included.

- T-13 waits for C0-0A formula lib (kept as dependency note in done_when, not skipped).
- QualityPort real impl is Phase 2 (fake used; T-16 hook is behind flag) — not a task.
- Section 6 CR candidates are not tasks.
- AC ranges expanded using ids in 01-PRD.md (e.g. AC-01.5b, AC-03.2a added where range covers them). T-32 keeps `07 s5`, T-34 keeps `cross-cutting` as the plan lists no AC ids.
- T-31/T-32 depend list "all"/"all endpoints" expanded to concrete task ids; `verify` = `pnpm -s verify` for all (matches C0 task file).

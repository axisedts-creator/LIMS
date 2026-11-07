CHANGES

Re-review of `git diff c8d0b9c..HEAD` (through d6e3b1c) against C4 02-TRD §3.1/§3.3/§7/§11.1, 06 row FD-T01. Ran verify.cmd parts: vitest 27/30 (3 failed), node:test 9/9.
The only change since the last review is a status line in `.orchestra/notes/FD-T01-impl.md`. Code is unchanged: names are verbatim, stubs throw `common.service_unavailable` without echoing request data, there are no secrets or PHI, every path is C4-owned and the nav entries are empty. This task has no DB/RLS.

1. done_when "Core boots with module" is still not met. `services/api/src/modules/frontdesk/__tests__/unit/boot.test.ts:87,94,109` still fail with `Error: strict mode: unknown keyword: "x-coded-set"`, because `services/api/src/core/openapi.ts` AJV_OPTIONS still has no `keywords: ['x-coded-set']`. The fix is outside C4: C0-0D must apply `.orchestra/cr/FD-T01.md`. No C4 change is needed or allowed. Do not work around it and do not weaken the tests. Once C0 lands the fix, re-run verify.cmd and expect 30/30 + 9/9, then re-review. More writer-only cycles cannot clear this item, so the orchestrator should escalate the CR to C0 instead of sending FD-T01 back to the writer.

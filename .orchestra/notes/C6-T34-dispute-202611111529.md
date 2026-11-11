# C6-T34 dispute (writer) — ownership blocker, not a wrong test
The static test is spec-correct. The 8 failing pins (20/28 now) all target tests/load/reporting-load.js and tests/e2e/reporting-journey.e2e.ts. Both match run.ps1 $TestPat `(^|/)tests?/` and are not in $TestExempt, so run.ps1 reverts any writer/debugger edit (debug rounds 1-2 rewrites were discarded; files unchanged since 19643945).
tests-note "Review pass 2" says the tester rewrote them, but commit 7d131b37 touched only the static test + CR rename; the harness still has /render, release path, /v1/reporting/deliveries, {token}, no tokens.length guard.
Needed (one of): (a) TESTER applies review items 1-10 to both harness files (content per C6-T34-debug.md round 2); or (b) lead adds `^tests/(load|e2e)/(?!.*\.test\.)` to $TestExempt so the writer can do it.
Writer stops here; no implementation file is editable for this task.

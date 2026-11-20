APPROVE

Reviewed `git diff 5bea7f96a..HEAD` (tester 48ee02e50, writer b1cc6b555) against the brief, LD-353, LD-362 and LD-434.
- LD-434 option A is followed. The REAL regex now also accepts `legacy baseline LD-434, fix in T0D-UIGUARD-1-<FEATURE>` and `owned by T0D-<id>`. The R1-R6 detectors, the stale-entry test and the honesty tests are unchanged and not loosened.
- Registry: the /admin/* rule 2 entry is pinned (rs-c2.static). The 115 legacy entries go through `legacy()` and are grouped by area. notes/T0D-UIGUARD-1-exceptions.md mirrors the registry: the guard's notes test enforces this and it is green.
- notes/T0D-UIGUARD-1-screens.md exists. It says no page or CSS was changed and gives the reason: a fix would make the tester-owned entries stale. LD-434 allowed fixes within the budget but did not require them.
- Scope: only core/__tests__, notes/ and .orchestra/notes are touched, with 4 product files, under the 12-file cap. There are no admin, platform or (auth) edits, no source, route, permission or contract change, no PHI and no secrets. RLS, idempotency, rate tier and error codes do not apply to a test-only task.
- Ran: build:nav, then vitest -c src/core/__tests__/vitest.uiguard1.config.ts. Result: 2 files, 25/25 passed.
- Not re-run: the shell and kit tests (m2.source, r04.*, m4.source, elabmenu1.sidebar, m-series-kit, web-style-3). No source, CSS or token file changed in this diff. The founder PC apply-script run was not verified here.
- Left for the lead: one follow-up task per heading T0D-UIGUARD-1-<AREA> in notes/T0D-UIGUARD-1-exceptions.md.

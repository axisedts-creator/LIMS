# SEC-HYG-1 impl (writer)
- 11.1: `git rm --cached` of 3 `test-results/` files + `.orchestra/notes/HC-T26-analyze.tmp` (kept on disk); `.gitignore` adds `.tmp/` and `test-results/`.
- Pollers (LD-240): QueueConsole, DiscountApprovalsInbox, CriticalAlertsPanel, StatusBoard, ManifestInbox skip the call while `document.visibilityState === 'hidden'`; interval and error handling unchanged.
- [CONV] inline guard, same as the 4 pollers that already pause (AgentsList, DashboardActions, ReportsWorklist), not `usePolling`: its 5/15/30 s back-off changes error handling, and the tests require the plain period.
- 11.3: `tools/lint/gen-stubbed-operations.mjs` (`--out`, `--check`) + generated `docs/stubbed-operations.md` (identity 3, inventory 2, partners 2, smartreport 1).
- [CONV] stub detection is a static token match over the handler index and the files it spreads, not a parse; ceiling noted in the script header (`ponytail:`).
- Run: `sec-hyg1.test.mjs` 12/12; `sec-hyg1.pollers.test.tsx` 29 pass, 2 skipped (by design); existing reporting, lab, frontdesk, engagement, partners web tests pass under their own configs.
- Review round: generator gate now also matches `notImplemented` / `stub(` (frontdesk, reporting); doc text names generic fail-closed error; regenerated (stub list unchanged). Review item 1 (test typing) done by tester. CR `SEC-HYG-1.1.nonblocking.md`: wire tests into verify/CI.
- Open: `pnpm -s verify` not run (web typecheck was already red before this task); `node --test tools/lint/tests` has 2 failures, supabase-pin and build smoke, in files I did not touch (not checked against a clean tree).

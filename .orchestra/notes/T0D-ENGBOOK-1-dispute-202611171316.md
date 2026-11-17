# T0D-ENGBOOK-1 dispute (debugger)
- Failing test: apps/web/src/features/engagement/__tests__/adminpage-eng-1.static.test.ts:94 ("no new permission and no contract change"), a test of ADMINPAGE-ENG-1, not of this task.
- It pins contracts/permissions.yaml byte-identical to git `052539369` (tree before ADMINPAGE-ENG-1). Commit db5fcccda "[writer] T0C-ACCT-1 impl" later added 7 billing.account*/expense/cash_transfer permissions there (LD-313 c, comment in the file). `git log 052539369..HEAD -- contracts/permissions.yaml` lists only that commit.
- T0D-ENGBOOK-1 touches no contract or permission file (this task's brief forbids new permissions/routes). No implementation change can make the byte-compare pass without reverting T0C-ACCT-1.
- Test contradicts the lead-approved T0C-ACCT-1 change (LD-313 c). I may not edit tests. Needs arbiter: re-pin BASE to a commit after db5fcccda, or compare only the engagement.* lines. All 3 task-owned suites (t-b6, t-q4, t-l1) pass.

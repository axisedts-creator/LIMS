# T0D-TESTIMPORT-1 debug
- Cause: verify log shows no test failure. 12/12 source tests passed; screen test file never ran: "[vitest-pool] Failed to start forks worker ... Timeout waiting for worker to respond" (host load, source test alone took 34 s). Same class as LD-317 worker timeouts.
- Fix: none, no code defect. Re-ran testimport1 config: 2 files, 70/70 pass (190 s). Implementation and tests unchanged.
- Note: impl.md lists testfix1 10/122 fail as pre-existing on untouched pages; not re-run here (the log never reached that step). Tester should confirm on clean HEAD.

## Round 2
- Cause: testfix1 10/122 fail (error-path tests expect throw to error.tsx) vs LD-353 rule 6 PageError, implemented earlier by T0D-UILIST-3 (1093e651c) in catalog/tests, test-categories, comment-codes pages. Not touched by this task.
- Fix: none in code (test contradicts spec). Wrote notes/T0D-TESTIMPORT-1-dispute.md; no code or test edited.

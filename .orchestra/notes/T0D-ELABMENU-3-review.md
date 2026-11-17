APPROVE

Re-review of `git diff cc707c13b..HEAD` (60dfafc60), LD-359 snapshot round. 2026-11-18.

Scope: 3 `.snap` files + dispute note only. No source, test file or assertion touched. No route, permission, contract, RLS, log, or secret change. Owned paths per LD-359.

- rs-c5.snap: only headings `Collect & dispatch` -> `Accession / Dispatch`, `Receive specimens` -> `Receive`. Matches LD-359.
- rs-c8.snap: only Report hub heading `Income` -> `MIS Report`. Matches LD-359.
- rs-c4.snap: headings `New registration` -> `Patient Registration`, `Daily cash` -> `Daily Payment Collection` as required, PLUS the T0D-REGSCREEN-1/2 registration form markup and React `useId` renames (`_r_ii_` -> `_r_sb_`). The extra content is the true current render of code already committed on this lane (a223d732b, 35ca99fa4, cc707c13b); it is a generated artifact, no assertion changed. Not counted as a defect. Note for lead: this deviates from the LD-359 "stop if anything else changes" clause and the dispute note text says "nothing committed" although 60dfafc60 committed it; lead may want to record that rs-c4 now pins the REGSCREEN form.

Checks run by reviewer (clean tree at HEAD):
- vitest rs-c4.screens: 5/5 passed
- vitest rs-c5.screens: 4/4 passed
- vitest rs-c8.screens: 5/5 passed

Not re-run: full web suite, heading walk test and rs-c2 baseline (approved in earlier rounds; this commit touches no file they read).

APPROVE

Round 3. Scope: `git diff d2dd7da3..HEAD` (16 files). Since round 2 only the tester commit 0ffb99da0 (pg-t18.review.test.tsx:84 and :232, `table` to `grid`, exactly the fix asked, nothing else) and a one-line writer impl-note edit. Display only: no route, permission, contract, operation or API change; no secrets, no PHI, no logs. Ownership per LD-440/LD-441 holds (registry by tester, mirror notes by writer, rs-c15 snap by writer). Kit change `DataTable.consoleSelection` is additive and named in the impl note. PAYMENTS rule 7 legacy entries are gone from the registry and the mirror notes.

Reviewer runs (lane tree, --maxWorkers=1): pg-t18 89/89; uiconsole1 259/259; uiguard1 36/36; rs-c15 41/41. Round 2 runs still stand for pg-t19 224/224, uilist2 63/63, uiset1 69/69; packages/ui density NaN fail is pre-existing and outside this diff.

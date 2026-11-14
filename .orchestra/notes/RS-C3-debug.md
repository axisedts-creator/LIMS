# RS-C3 debug
- Cause: two route pages kept inline style on a stack div: `catalog/tests/page.tsx:14` and `catalog/tests/[test_id]/page.tsx:100` (`style={{ gap: 'var(--lims-space-N)' }}`). Static test flagged 2 inline-style hits.
- Fix: use packages/ui `Stack` (`gap={3}` / `gap={4}`) in both pages. Same markup class, no API/route/behaviour change.
- Round 2: the log still showed both hits and the files still had the inline style (round-1 edit not in the tree); re-applied the same `Stack` fix in both pages.
- Check: rs-c3.static.test.ts 8/8 pass. One earlier run hit a 5s timeout in the emoji scan (cold fs); passed on rerun.

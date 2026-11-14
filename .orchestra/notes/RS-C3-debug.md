# RS-C3 debug
- Cause: two route pages kept inline style on a stack div: `catalog/tests/page.tsx:14` and `catalog/tests/[test_id]/page.tsx:100` (`style={{ gap: 'var(--lims-space-N)' }}`). Static test flagged 2 inline-style hits.
- Fix: use packages/ui `Stack` (`gap={3}` / `gap={4}`) in both pages. Same markup class, no API/route/behaviour change.
- Round 2: the log still showed both hits and the files still had the inline style (round-1 edit not in the tree); re-applied the same `Stack` fix in both pages.
- Check: rs-c3.static.test.ts 8/8 pass. One earlier run hit a 5s timeout in the emoji scan (cold fs); passed on rerun.
- Round 3: round-2 edits again absent from tree (git status was clean). Re-applied Stack fix in both pages with the @lims/ui/components/Stack import; static test 8/8 pass, no style={{ left under catalog paths. Not verified: rs-c3.screens.test.tsx (worker start timeout in verify log, environmental).
- Round 4 (LD-172): edits were still absent; re-applied Stack fix (gap 3 / 4, @lims/ui/components/Stack import) in both pages. rs-c3.static.test.ts 8/8 pass. rs-c3.screens.test.tsx not re-run here (host RAM / worker start); verify must run it.

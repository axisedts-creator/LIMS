TESTS_WRONG — emptytbl2.other.test.tsx:145 requires the development note "Chart component pending", which LD-353 rule 8 forbids on the page.
Reasons:
1. LD-353 (binding, .orchestra/inbox/T0D-PRICETOOLS-1-arbiter.md:33) rule 8: "Copy: ... no development notes". The test requires one to be visible.
2. Newer tests require the opposite: quality/__tests__/quality-t21.lj.test.tsx:142-151 (`not.toContain('Chart component pending')`, citing T0D-UIDASH-1-ruling.md) and quality/__tests__/uidash1.quality.test.tsx:7,99,127. The two cannot both pass.
3. quality/components/LjView.tsx:4 says T0D-UIDASH-1 removed the banner under LD-353 rule 8. T0D-PRICETOOLS-1 did not do it. This failure is older than this task and does not block it.
4. The rest of the T0D-EMPTYTBL-2 test still holds: headers when empty, the message row, the heading and the legend (lines 136-144).
Change in the test (line 145) of apps/web/src/features/catalog/__tests__/emptytbl2.other.test.tsx:
  replace `expect(screen.getByText(/Chart component pending/)).toBeTruthy();`
  with    `expect(screen.queryByText(/Chart component pending/)).toBeNull(); // LD-353 rule 8, T0D-UIDASH-1`
  and drop `and the "table instead of chart" notice` from the it() title on line 141. Leave lines 143-144 as they are.

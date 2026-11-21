# T0D-TESTIMPORT-1 dispute (writer) — 2 of 70 tests cannot pass with any implementation; 68 pass

1. `testimport1.screen.test.tsx` "Download errors file: disabled without errors; with errors ..." (line 371) calls `validated()` twice. `validated()` waits for
   `validates()` to have length 1 (line 78), but `API.calls` is not reset between the two calls, so the second call always sees 2 POSTs and times out.
   Fix (tester): in `validated()` use `const before = validates().length` and wait for `before + 1`, or reset `API.calls` before the second pick.
2. Same file, "picking a second file replaces the first result" (line 394) expects `bodyRows(errTable())` to be 0 after a clean file. The test "a clean file ..."
   (line 316) requires the same state to show the empty message as a body row INSIDE the table (`expectEmptyTable(..., /no errors/i)`, LD-336), and `bodyRows`
   uses the same filter as `messageRow`, so it counts that message row (1). The two tests contradict each other for one state.
   Fix (tester): line 394 `expect(bodyRows(errTable()).filter((r) => cells(r).length === 4)).toHaveLength(0)` or `expectEmptyTable(errTable(), /no errors/i)`.
- Not worked around (e.g. moving the message row into a <tfoot>), because that would bend the LD-336 table pattern to fit a test defect.
- Regression: testmgmt1 141/141, web-t35 96/96, rs-c2 74/74. testfix1 10 fail / 112 pass: all in /catalog/tests and /catalog/comment-codes error paths
  ("the page must throw, not render"), pages this task does not touch; not re-run on a clean HEAD (git stash was blocked here), so pre-existing is unproven.

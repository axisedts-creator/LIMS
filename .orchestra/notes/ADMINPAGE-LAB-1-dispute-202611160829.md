# ADMINPAGE-LAB-1 dispute (writer)
Test: apps/web/src/features/lab/__tests__/adminpage-lab-1.critical-values.test.tsx line 181-186, "no critical value: the spec text "No critical values." and no table row".
Wrong: it asserts `expect(links()).toEqual([])`, but `links()` (line 75) is `screen.getAllByRole('link').filter(...)`. `getAllByRole` THROWS "Unable to find role=link" when the page has zero links, so the assertion can never pass on a correct empty state (the spec empty state has no link; "No critical values." is the whole content).
Fix wanted (tester): use `screen.queryAllByRole('link')` in that test (as the worklists test does), or make `links()` use `queryAllByRole`.
Writer did not add a link to the empty state to satisfy it (that would be an invented control). Status: 49/50 pass; this is the only failure.

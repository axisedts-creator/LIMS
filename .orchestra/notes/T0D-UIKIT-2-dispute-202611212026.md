# T0D-UIKIT-2 dispute (writer)

Writer stopped before implementing: two sets of tests contradict each other on `.lims-card`, and the writer may not edit tests.

- uikit2.kit.test.tsx:70-75 (new, follows done_when 2) requires `.lims-card` { border: 1px solid var(--lims-neutral-200); border-radius: var(--lims-radius-md); box-shadow: var(--lims-elevation-1) }.
- m-series-kit.test.tsx:184-200 requires a Card radius of 24 (xl), `border` 0/none and `box-shadow` none. done_when 6 names `m-series-kit` as a pin that must stay green.
- ui-r03-kit-pass.test.tsx:133 requires `.lims-card` to use `var(--lims-radius-xl)`.
- No CSS satisfies both. The brief contradicts itself: done_when 2 and done_when 6 (the m-series-kit pin).

Ruling needed (arbiter or lead):
- (a) done_when 2 wins. The tester updates m-series-kit:184-200 and ui-r03:133 to radius md, the hairline and elevation.1, citing LD-436. Or
- (b) the pin wins. The tester drops uikit2.kit:70-75, and Card keeps radius 24 with no border and no shadow. Or
- (c) the new look goes on an additive modifier class, for example `.lims-card--hairline`. Both test files then change to match.

Also blocked: the look spec C:/LIMS-state/ui-plan/LD-436-look.md is outside this worktree and permission to read it was denied. The LD-436 and LD-437 text in the inbox is cut off. The writer needs both to match the mock exactly.

Other contracts in the tests look implementable as written: Card caption, StatusStepper mostWaitingId, the state art, ActionList, and the chevron-right added to Icon.

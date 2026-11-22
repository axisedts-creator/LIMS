APPROVE

Range `1d482f59e..HEAD`; new since last review: d0c28268f (tester) and 6e13b9a2d (writer).
Item 1 fixed: rs-c7.behaviour.test.tsx:93 now asserts a gridcell with text `up`, exactly as asked (pins old cell spacing only, data still asserted). left.md moves it to "From this task (tester change done)"; impl.md checks updated.
LD-443 snapshot check from the prior review stands (rs-c2, rs-c4, rs-c7 diffs are markup only, 0 word differences). No snapshot changed since.
No route, permission, contract, API, CSS or tokens change. No PHI, no secrets. Only owned paths.
Runs (12:36 NPT, per-task configs): uix4 9/9; rs-c7 34/35. The only red is rs-c7.static:101 (`instruments.nav.settings` from nav.manifest.ts:10 and InstrumentSettingsForm.tsx:127, not task files). rs-c4.static's 5 baseline reds were already shown in the prior review to come from other merged tasks.

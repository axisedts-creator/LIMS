APPROVE
Range d7dff0641..HEAD (3 commits): shell.css:263 card border 1px -> 0.0625rem; uikit2.shell.test.ts:42/53/58 per ruling 21:42 items 3-4; notes only otherwise.
Matches ruling exactly: tokens only, no px, !important kept, after padding rule, kit.css lims-card and m-series-kit/ui-r03 untouched, no fixture/baseline or exemption change, tokens.json unchanged.
Display only: no route, permission, contract, operation, API, RLS, logging or secret change; only owned paths (apps/web shell + .orchestra notes).
Reviewer runs 21:45 NPT: ui uikit2 x2 + m-series-kit + ui-r03 230/230; web uikit2 config (uikit2.shell, m2, m4, r04) 59/59; web-style-3 config 101/101; elabmenu config (incl. elabmenu1.sidebar) 99/99. All green.
Not checked here: visual match to the mock, web feature tests (open in impl notes).

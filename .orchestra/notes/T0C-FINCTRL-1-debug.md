Debugger: verify log shows 1287/1288 pass; finctrl1, acct1, c4, regparity2 all green.
Cause: acctlist1-openapi.test.ts:260 is stale. The web summary page now cites the list path after T0D-UILIST-2 (LD-358); FINCTRL never touches that page.
Fix: none in implementation (would mean reverting another task). Wrote T0C-FINCTRL-1-dispute.md; the test needs a tester/arbiter update.

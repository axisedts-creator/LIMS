TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- spec/research/04-consolidated-decisions.md:171 (L16): FY starts Shrawan 1 (B.S. month 4). So FY `Y/(Y+1)` runs Shrawan 1 Y .. last day of Ashadh (month 3) Y+1.
- spec/chunks/C0-foundation-contracts/01-PRD.md:104 (AC-0A-3.3): the day before Shrawan 1 of Y+1 is in FY `Y/(Y+1)`; Shrawan 1 Y+1 starts FY `(Y+1)/(Y+2)`. Chaitra (month 12) of Y+1 comes after Shrawan 1 Y+1, so it belongs to FY `(Y+1)/(Y+2)`.
- Test `packages/shared-ts/test/bsdate.test.mjs:168-179` claims Chaitra end of Y+1 is in FY `Y/(Y+1)`. That contradicts the AC and the test at l.145-157 of the same file. The writer's observed `2001/02` for 2001-12-30 B.S. is correct.
- The Baisakh 1 (Y+1) check in this test is correct. Keep it.

Required test change (l.168-179):
- Rename the test to "whole FY is constant: Baisakh 1 and Ashadh end of year Y+1 share the FY started Shrawan 1 of Y".
- l.174: `nextChaitra` -> `nextAshadh = ms.find((r) => r.bs_year === Y + 1 && r.bs_month === 3)`; l.175 compute `lastDay` from `nextAshadh`.
- Keep both asserts (`.long === fy(Y)` for Baisakh 1 and lastDay; `endsOn === lastDay`). Make the same change in any Dart counterpart.

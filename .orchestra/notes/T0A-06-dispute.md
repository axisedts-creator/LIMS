# T0A-06 dispute (writer)
Test: `packages/shared-ts/test/bsdate.test.mjs:168` "whole FY is constant: Baisakh 1, Chaitra end of year Y+1 share the FY started Shrawan 1 of Y".
Why wrong: FY starts Shrawan 1 (month 4) (04 L16, AC-0A-3.3), so FY `Y/(Y+1)` = Shrawan 1 Y … last day of **Ashadh (month 3)** Y+1. Chaitra (month 12) of Y+1 falls after Shrawan 1 Y+1, i.e. in FY `(Y+1)/(Y+2)`. The test itself (l.145–157) already asserts the day before Shrawan 1 Y+1 is the end of FY Y — the two tests contradict each other.
Observed (wrapper, preview golden): `fiscalYearBs('1945-04-12')` (2001-12-30 B.S.) → `2001/02`, test expects `2000/01`.
Fix suggestion: use `bs_month === 3` of Y+1 instead of `12` (`nextChaitra` → `nextAshadh`); `endsOn === lastDay` then holds.
Other 17/18 golden-based TS tests pass against a preview golden. Separately, the review.json test fails by design: 107 real library disagreements await human resolution (see T0A-06-impl.md).

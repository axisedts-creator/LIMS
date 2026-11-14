# Cost per test

Cost per test (CPT) tells you what one test cost in reagent and supplies, for a test on an analyser over a period. It is on the Cost per test tab at /inventory/reports and needs the permission inventory.cost.read.

## Three numbers

- Direct cost per test: the value of everything deducted for that test (test, analyte, rerun, QC and calibration deductions, less reversals) divided by the number of tests. Shown as Direct CPT.
- Fixed cost: deductions that belong to the analyser and not to one test, such as the per analyser-day rule. It is shared across tests in proportion to the number of tests.
- Loaded cost per test: direct cost plus the test's share of the fixed cost, divided by the number of tests. Shown as Loaded CPT.

A test counts once, by the analyser of its first verified result. With zero tests the result is empty, not zero.

## What is not included

Wastage, expiry write-offs and count differences are not part of CPT. They would have to be spread over tests by guesswork, so the Wastage report shows them in full instead.

## Standard CPT and rounding

Standard CPT is what the active rules say a test should cost at the current average cost of each item. If an item has no cost the row shows an "incomplete" badge and lists the missing items. All amounts are rounded half up to whole paisa, once per movement; the final division is rounded half up as well.

Back to [consumption-model.md](consumption-model.md).

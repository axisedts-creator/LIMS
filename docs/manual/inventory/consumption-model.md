# Consumption model

> "Your analysers send us patient results and QC results, but they do not tell us how much reagent is left in the bottle. That information stays inside the analyser or the vendor's own software. So LIMS counts usage the way your staff would. You tell us once, for example 'one glucose test on analyser BIO-1 uses 1 test of glucose reagent' and 'each QC run uses 1 test of reagent plus 0.1 mL of control'. From then on, every verified result, QC run and rerun is deducted automatically, normally within a minute. Calibrations are logged with one click. At a stock count, any difference between the counted stock and the system stock is shown as wastage, so leaks, spillage and unrecorded repeats become visible. If your analyser vendor can later give us an official interface for reagent levels, we can add it as an extra check. The counting model stays the record either way."

## How rules work

You set rules once. A rule says: for this kind of event, on this analyser, deduct this quantity of this item. The kinds are:

- Per test: deducted once for each test on an order when its first result is verified.
- Per analyte result: deducted once for each verified result of that analyte.
- Per rerun: deducted when the analyser reports a rerun.
- Per QC observation: deducted for each QC result received from the analyser.
- Per calibration: deducted when someone logs a calibration on the Bench page, or when the analyser reports one (supported analysers only).
- Per analyser-day: deducted once per day for each day the analyser sent any results.

Rerun detection depends on the analyser driver reporting reruns. This is UNVERIFIED per analyser model (B2: exact models and manuals not received), so a rerun rule may deduct nothing on some analysers.

Deductions come from the store linked to the analyser, or from the default consumption store. A deduction that finds no store waits in the Waiting consumption list. Automatic consumption can be switched off in Settings; then nothing is deducted until a manager turns it on. Changing a rule never changes earlier deductions.

Related: [rules.md](rules.md), [cost-per-test.md](cost-per-test.md).

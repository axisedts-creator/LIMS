# QC set-up: Plans

## Purpose
A plan says how QC is run for one analyte on one instrument: how many controls per run (N), which levels, and which rules decide a run.

## Fields
- **Controls per run (N)**: 2, 3 or 4. The counts of the levels must add up to N.
- **n-x rule**: how many values in a row on one side of the mean reject a run. The choices depend on N.
- **Run window**, **QC valid for**, **Hold look-back**: minutes or hours as shown.

## Rules
The text under the form shows the rules that will be applied. A plan can be activated only when every level has an active target. Saving an edit creates a new version and needs a reason.

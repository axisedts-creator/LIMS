# Levey-Jennings chart

## Purpose
Plots QC values against the target mean and the 1, 2 and 3 SD lines, so drift and shifts are visible before a run fails.

## Fields
- **Markers**: ● Accepted, ▲ Warning, ✕ Rejected (with the rule), ○ Excluded, ◇ Unevaluated, ◌ Collecting. Every point also has its status as a word in the table.
- **Target v1, v2...**: a new target starts a new step; each target keeps its own lines.
- **One level / All levels (SD units)**: one level in measured units, or all levels as z-scores (distance from the mean in SD).

## Rules
Levels and lots are never merged on one line. Open a point (Enter) to see the value, open its run, or, with the manage permission, exclude it with a reason. The chart refreshes every 15 seconds while the tab is visible. Up to 2,000 newest points are shown.

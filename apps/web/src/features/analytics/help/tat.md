# Turnaround time (TAT)

## Purpose
Shows how long each stage takes, from collection to the released report, so you can find where time is lost.

## Metrics
Each segment shows the number of samples, the median, the 90th percentile and the maximum. Anomalies are excluded and counted separately.
- **Pre-analytical (M60)**: Collection → receipt at lab. Starts when the sample is collected, stops when it is received at the lab.
- **Transport (M61)**: Centre scan-out → lab scan-in. Starts when the centre scans the sample out, stops when the lab scans it in.
- **Within-lab (M62)**: Receipt → first verified result. Starts at receipt at the lab, stops at the first verified result.
- **Total, first report (M63)**: Registration → first report released.
- **Total, final report (M64)**: Registration → final report released, only for orders where every report is final.

Server times are used, not analyser clocks. Priority and specimen-type filters apply to sample segments only. Aliquots are left out of M60 to M62.

## Periods and business day
Each sample is counted on the business day its segment ends. A business day runs 00:00–24:00 Nepal time (UTC+05:45). Periods show A.D. and B.S. dates.

## Freshness
"Updated {time}" shows the last calculation. "Data may be out of date" means changes are still being processed.

## Centre scope
You only see centres you have access to. Users with access to all centres see all centres.

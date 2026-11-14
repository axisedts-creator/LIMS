RS-C6 impl (review round, LD-140/LD-170)
- ReportDetailView.tsx: removed inline `<object>` PDF preview (review 1: it hit the logged, rate-limited download route on every render); `.rpt-preview` region now holds only the existing download link. Removed `.filter(ds[s] > 0)` so all six delivery counts show, also at 0 (review 2).
- report-preview.css: `.rpt-preview-paper` min-height 480px swapped for space-4 padding (box no longer holds a PDF) [CONV].
- Snapshots re-recorded once: `-u rs-c6.screens` (2 updated).
- Checks: RS-C6-verify.cmd 60/60 pass (CI=true); C6-T31 config 200/200 pass.
- Open: inline preview needs a CR (inline-disposition view endpoint not logged as download); per-channel last-sent status needs API data (CR).

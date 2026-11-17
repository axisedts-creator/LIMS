# AN-T23 dispute (writer)
Test: `harness.test.ts` > "limits equal the TRD §12 Target p95 column" — `trdTargetsMs()` is wrong, not `TARGETS`.
- Its row filter `/^\| [^|]+\| ≤ [\d.]+ (ms|s|min)\b/` needs the Target cell to *start* with `≤`. TRD §12 row 6 is `| export ≤ 10,000 rows | ready ≤ 60 s p95 | |` (cell starts with "ready"), so it is skipped.
- Result: test derives 7 values `[300,500,1500,2000,300,120000,30000]`; spec has 8 (`export_10k` = 60000 between pending_summary and refresh_lag). Test's own header and `KEYS` say 8, so it contradicts itself.
- `TARGETS` follows TRD §12 verbatim (300, 500, 1500, 2000, 300, 60000, 120000, 30000); I will not drop the export row to satisfy the regex.
Fix (tester): allow an optional word before `≤`, e.g. `/^\| [^|]+\| (?:ready )?≤ [\d.]+ (ms|s|min)\b/`.
Also blocked, not test bugs: `trd.decision.test.ts` needs the TRD §12 "Sweep-interval decision" line (spec/ read-only -> lead/CR); `report.test.ts` + 1x/10x agreement need `results/{1x,10x}.json` from a live run on a seeded DB.

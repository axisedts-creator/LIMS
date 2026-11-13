TESTS_WRONG — `trdTargetsMs()` row filter drops the export row, so the test derives 7 limits where TRD §12 defines 8.
Reasons:
- spec/chunks/C8-analytics-mis/02-TRD.md:818 — the column is "Target p95". Rows 820–827 are the 8 latency/wall operations; row 828 (req/s) is not a latency target.
- 02-TRD.md:825 — `| export ≤ 10,000 rows | ready ≤ 60 s p95 | |`: the Target cell starts with "ready", so the regex `/^\| [^|]+\| ≤ .../` in harness.test.ts:18 skips it.
- The test contradicts itself: harness.test.ts:2 and :13 (`KEYS`) list 8 operations including `export_10k`, but `trdTargetsMs()` returns 7 values `[300,500,1500,2000,300,120000,30000]`.
- The implementation's `TARGETS` limits (300, 500, 1500, 2000, 300, 60000, 120000, 30000) match 02-TRD.md:820–827 in order.
Change to the test (harness.test.ts:18 only): allow the optional "ready " prefix before `≤`, e.g. `/^\| [^|]+\| (?:ready )?≤ [\d.]+ (ms|s|min)\b/`. Line 20's `/≤ ([\d.]+) (ms|s|min)/` already parses "ready ≤ 60 s p95" to 60000. Optionally add `expect(trdTargetsMs()).toHaveLength(8)` so a silently dropped row fails loudly.
Not covered by this ruling: the missing "Sweep-interval decision" line in TRD §12 (trd.decision.test.ts) and the `results/{1x,10x}.json` live-run artefacts. Those are blockers for the lead or a CR, not test defects.

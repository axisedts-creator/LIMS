T-OPS1 review (lead, 2026-11-13). Verdict: CHANGES. The only failure is the missing core metric rows; the C16 code and tests are right (17 api + worker tests pass).

LD-142 approves the CR: it authorises exactly these edits in core/observability, nothing else.
- TESTER: add the 13 lims_engagement_* names and types to EXPECTED in services/api/src/core/observability/__tests__/metrics.test.ts.
- WRITER: add the same 13 entries to DEFS in services/api/src/core/observability/metrics.ts, [type, labels, help] shape, labels exactly as in LD-142 / 02-TRD section 13 lines 812-824 / ENGAGEMENT_METRICS.
Then the T-OPS1 verify must show the 15 'core registry' tests green. Do not change anything else.

CHANGES
1. services/api/src/core/observability/metrics.ts:74 — the binding LD-127 says "cite them in code comments", but the C15 block comment does not mention LD-127. Fix: change the comment to `// C15 payments (PG-T20; LD-127 2026-11-12; 02-TRD §11 incl. the 08 A22.4 backing gauges; names, types, labels verbatim)`. Change nothing else.

Checked and OK (no action needed):
- The 12 DEFS entries match TRD §11 line 548 and LD-127 exactly (names, types, labels). metrics.test.ts EXPECTED has the same 12, with the C15 comment. No other core/observability change.
- payments.rules.yml matches the 9-row §11 alert table exactly (expr, for, severity). Runbooks RB-1…RB-9 are present.
- Tests run: api metrics.test.ts + payments observability.test.ts 51/51 pass; worker sweep_gauges.test.ts 18/18 pass.
- No PHI or secrets. No RLS, route or permission changes in scope.
- Known open item, not a PG-T20 defect: worker JobContext has no `metrics`, so the sweep gauges do nothing in production until a core CR lands (PG-T20-ruling.md).

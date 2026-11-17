APPROVE
Re-review after writer commit 2e1463e8 (review fixes).
- Item 1 fixed: services/api/src/core/observability/metrics.ts:74 C15 block comment now cites LD-127 2026-11-12. Only the comment changed.
- 12 DEFS entries (metrics.ts:75-86) match LD-127 / TRD §11 line 548 exactly (names, types, labels). metrics.test.ts EXPECTED has the same 12 with the C15 comment. Nothing else in core/observability changed.
- payments.rules.yml = §11 alert table; RB-1…RB-9 present (checked in the first review, no change since).
- Tests run: `vitest run src/core/observability` 30/30 pass (metrics.test.ts 18/18). One earlier run had 1 failure that did not repeat; the verbose re-run passed fully. It was most likely http.test.ts timing (its first test takes about 3.2 s), and that file is not touched by this diff.
- No PHI, secrets, RLS, route or permission changes in scope.
- Still open, not a PG-T20 defect: worker JobContext has no `metrics`, so the sweep gauges do nothing in production until a core CR lands.

CHANGES

Reviewer: HC-T17 round (LD-162), diff b1672baa..06c5d6d9.
Check run: `npx vitest run src/core/observability/__tests__/metrics.test.ts` (services/api): 1 failed / 17 passed. Failing: "REQUIRED_METRICS lists exactly the spec names" (metrics.test.ts:125); REQUIRED_METRICS = Object.keys(DEFS) now has 8 extra names that EXPECTED lacks. The impl note ("84 pass / 1 fail = http.test.ts") does not match this result.

1. `services/api/src/core/observability/__tests__/metrics.test.ts:117` — LD-162 requires the same eight rows in EXPECTED; the diff adds them only to DEFS. Fix (writer, as LD-162 names): after line 117 (`lims_identity_audit_exports_tenant_day: 'gauge',`) insert, with a comment citing LD-162 / C17 02-TRD §14 lines 589-596:
   ```
   lims_homecollection_mutations_total: 'counter',
   lims_homecollection_push_duration_seconds: 'histogram',
   lims_homecollection_snapshot_duration_seconds: 'histogram',
   lims_homecollection_held_open: 'gauge',
   lims_homecollection_clock_skew_seconds: 'histogram',
   lims_homecollection_devices_stale_total: 'gauge',
   lims_homecollection_handover_overdue_open: 'gauge',
   lims_homecollection_events_published_total: 'counter',
   ```
   Then rerun metrics.test.ts (must be 18/18) and HC-T17-verify.cmd, and correct the counts in `.orchestra/notes/HC-T17-impl.md`.

Checked OK: the eight DEFS rows in core/observability/metrics.ts:120-128 match 02-TRD §14 lines 589-596 verbatim (names, types, labels; tenant_id only on the three gauges, no PHI label); nothing else in metrics.ts or createMetrics changed; homecollection/metrics.ts comment updated only; no PHI in logs, no secrets, no RLS/permission/route surface touched in this diff. The HC-T20-review.md edits in this diff are lead-ruling notes (LD-171), not HC-T17 code.

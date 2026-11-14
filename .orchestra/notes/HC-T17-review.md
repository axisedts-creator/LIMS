CHANGES

Reviewer: HC-T17 round 2 (LD-162), diff b1672baa..390fb91b.
Check run: `npx vitest run src/core/observability/__tests__/metrics.test.ts` (services/api): 1 failed / 17 passed (18). Failing: "REQUIRED_METRICS lists exactly the spec names" (metrics.test.ts:125). The last writer commit (390fb91b) changed only `.orchestra/notes/HC-T17-impl.md`; `metrics.test.ts` is not in the diff at all.

1. `services/api/src/core/observability/__tests__/metrics.test.ts:117`: the round-1 fix was not applied. LD-162 requires the same eight rows in EXPECTED. Fix (writer): after line 117 (`lims_identity_audit_exports_tenant_day: 'gauge',`) insert, with a comment citing LD-162 / C17 02-TRD §14 lines 589-596:
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
   Commit the file, rerun metrics.test.ts (must be 18/18) and HC-T17-verify.cmd.

2. `.orchestra/notes/HC-T17-impl.md:5-6`: these lines say EXPECTED was updated and "core `metrics.test.ts` 18/18". Neither is true at 390fb91b (see check above). Fix: after item 1 lands, rewrite them with the real rerun output.

Checked OK (unchanged from round 1): the eight DEFS rows in core/observability/metrics.ts:121-128 match 02-TRD §14 lines 589-596 verbatim (names, types, labels; tenant_id only on the three gauges; no PHI label); nothing else in metrics.ts or createMetrics changed; homecollection/metrics.ts change is a comment only; no PHI in logs, no secrets, no RLS, permission or route surface touched in this diff.

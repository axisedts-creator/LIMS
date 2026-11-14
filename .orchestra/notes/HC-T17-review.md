LEAD RULING LD-162

CR-C17-HC-T17-REG is approved: additive, same pattern as LD-88, LD-120 and LD-142.

1. TESTER: no test changes. observability.test.ts already pins the eight metrics from spec/chunks/C17-home-collection/02-TRD.md:589-596. Weaken no assertion.
2. WRITER: in services/api/src/core/observability/metrics.ts, add exactly these eight DEFS rows (kind, labels) from 02-TRD.md:589-596:
   - lims_homecollection_mutations_total, counter, [type, outcome]
   - lims_homecollection_push_duration_seconds, histogram, []
   - lims_homecollection_snapshot_duration_seconds, histogram, [changed]
   - lims_homecollection_held_open, gauge, [tenant_id]
   - lims_homecollection_clock_skew_seconds, histogram, [clock_source]
   - lims_homecollection_devices_stale_total, gauge, [tenant_id]
   - lims_homecollection_handover_overdue_open, gauge, [tenant_id]
   - lims_homecollection_events_published_total, counter, []
   Take the help text from HOMECOLLECTION_METRICS in services/api/src/modules/homecollection/metrics.ts.
3. WRITER: add the same eight rows to EXPECTED in services/api/src/core/observability/__tests__/metrics.test.ts. Touch nothing else in either C0 file.
4. WRITER: rerun .orchestra\notes\HC-T17-verify.cmd. Expect the 18 registry failures to pass. If the grep_forbidden.sh status-null timeouts come back, rerun once on a quiet machine and report it; do not change the script or the test timeout.
5. Mark the CR file resolved and cite this LD in HC-T17-impl.md.

# HC-T17 debug
- Cause: all 18 failures = 8 lims_homecollection_* names absent from core DEFS (services/api/src/core/observability/metrics.ts), so createMetrics throws "metrics: unknown <kind> <name>". Impl and tests are correct; no test contradicts spec.
- Fix NOT applied: DEFS + core/observability/__tests__/metrics.test.ts EXPECTED are C0 paths, not owned by C17 (CLAUDE.md). No LD/CR-register entry authorizes it yet (precedent LD-88/120/142).
- Needs: lead decision approving .orchestra/cr/HC-T17-registry.md (add 8 DEFS rows + 8 EXPECTED rows, additive). Then rerun HC-T17-verify.cmd; expect 18 pass.

## Round 2
- Re-verified: same 18 failures, same cause (8 lims_homecollection_* names missing from C0 core DEFS). No new LD/CR-register approval exists (only LD-140, UI-only), so core/observability/metrics.ts stays untouched (not a C17 path).
- Fix still pending lead approval of .orchestra/cr/HC-T17-registry.md: add 8 DEFS rows + 8 EXPECTED rows (additive). Then rerun HC-T17-verify.cmd.

## Round 3
- Verify log shows 21 fails = the same 18 metrics-registry failures (8 lims_homecollection_* names missing from C0 core DEFS) + 3 grep_forbidden.sh cases with status null (60s spawn timeout under a 613s loaded run, not a defect: rerun of all 13 grep_forbidden tests passes, 13/13).
- Metrics fix still not applied: core/observability/metrics.ts is C0-owned and no LD/CR approval exists for .orchestra/cr/HC-T17-registry.md. Needs lead approval, then rerun HC-T17-verify.cmd.

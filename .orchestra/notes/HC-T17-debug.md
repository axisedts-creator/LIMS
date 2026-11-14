# HC-T17 debug
- Cause: all 18 failures = 8 lims_homecollection_* names absent from core DEFS (services/api/src/core/observability/metrics.ts), so createMetrics throws "metrics: unknown <kind> <name>". Impl and tests are correct; no test contradicts spec.
- Fix NOT applied: DEFS + core/observability/__tests__/metrics.test.ts EXPECTED are C0 paths, not owned by C17 (CLAUDE.md). No LD/CR-register entry authorizes it yet (precedent LD-88/120/142).
- Needs: lead decision approving .orchestra/cr/HC-T17-registry.md (add 8 DEFS rows + 8 EXPECTED rows, additive). Then rerun HC-T17-verify.cmd; expect 18 pass.

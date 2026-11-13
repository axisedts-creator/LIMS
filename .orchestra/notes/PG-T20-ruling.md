CR_NEEDED
- C15 02-TRD §11 (spec/chunks/C15-payment-gateways/02-TRD.md:548) mandates 12 lims_payments_* metrics (10 + 2 backing gauges, 08-CR-REGISTER.md:2858 A22.4); the payments test (observability.test.ts:39-41) correctly requires them in REQUIRED_METRICS.
- The registry `services/api/src/core/observability/metrics.ts` and its test `core/observability/__tests__/metrics.test.ts` are C0-0D-owned (spec/program/01-CHUNK-MAP.md:123); C15 may edit neither (CLAUDE.md "Edit only paths your chunk owns").
- Core test :78 is not wrong per se: its EXPECTED is the closed list of registered names, extended only via CR (precedent CR-C8-016/LD-88, CR-C5-T31-001, CR-C14-T17-001 — each added DEFS + EXPECTED together).
- No CR authorizes C15 additions yet, and the writer's [CONV] edit of metrics.ts (d1c170d6) is outside the PG-T20 file list. Hence CR text written to .orchestra/cr/PG-T20.md (DEFS + EXPECTED, 12 names/labels verbatim from TRD §11).
- Until C0 accepts it, PG-T20 stays blocked on the metric-presence half; rules.yml and manual pages are unaffected.
- Separate open item from PG-T20-impl.md:6 (worker JobContext lacks `metrics`, gauges no-op in prod) also needs a core CR; not ruled here.

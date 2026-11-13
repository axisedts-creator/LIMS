# T-OPS1 debug
- Cause: all 15 fails = "core registry" group. 13 lims_engagement_* metrics absent from DEFS in services/api/src/core/observability/metrics.ts (C0 path) -> `metrics: unknown counter ...`. C16 code (metrics.ts, worker tasks, rules) is fine: 17 api + worker pass.
- Fix NOT applied: DEFS + core EXPECTED test are C0-owned; CLAUDE.md forbids editing outside chunk paths; no LD for T-OPS1 authorises it (LD-140 is UI only). Not a test-vs-spec dispute; tests are right.
- Needed: lead approves CR `.orchestra/cr/T-OPS1.nonblocking.md` (exact 13 DEFS rows + EXPECTED rows listed there), or rules the 15 tests out of scope. Re-run verify after.
- Round 2 (2026-11-13): re-checked. CR still unapproved, no LD covers C0 DEFS. Cause + status unchanged; no code edited. Blocked on lead.
- Round 3 (2026-11-13): re-checked. core/observability has 0 lims_engagement_* rows; CR .orchestra/cr/T-OPS1.nonblocking.md still unapproved. Same cause, no code edited. Blocked on lead.

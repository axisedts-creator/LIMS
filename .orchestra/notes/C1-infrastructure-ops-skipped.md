# C1 plan tasks skipped (not in task JSON)

None. The plan marks no task blocked/deferred; all 35 (T-01..T-35) are included.

Notes:
- Gated parts stay inside their tasks: T-20 (flag c7_metrics_live, CR-C1-003), T-33 (flags off), T-34 (needs C7 release build CR-C7-013, external), T-35 (prod enablement waits for C15 PG-T23), T-14/T-16 (C6 image placeholder), T-12/T-15 (CR-C1-002), T-24 (CR-C1-001).
- Plan paths without `infra/` prefix (roles, playbooks, inventories, monitoring, edge) normalised under `infra/ansible/` or `infra/`; the TRD gives no explicit tree.
- ACs ranges expanded to ids present in 01-PRD.md (AC-04.1–04.3a = 04.1, 04.1a, 04.2, 04.3, 04.3a). `IS-01`/`IS-28` kept as ids (PRD has no AC ids for them). T-04's "07-SEC log rules" is not an AC id, omitted.
- `verify` = `sh infra/tests/run.sh` (created by T-01); empty for T-32 (needs staging).

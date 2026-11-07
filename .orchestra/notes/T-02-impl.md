# T-02 impl (C5 writer)
- Files: `services/api/src/modules/lab/domain/{specimen.state,result.state,rollup}.ts` (pure, errors via core `LimsError`, codes in contracts/errors.yaml).
- Result: domain tests 100/100 pass (`npx vitest run src/modules/lab/domain/__tests__`); `tsc --noEmit` 0 errors. No lint script in services/api.
- Review fix 1: specimen table check first (`lab.specimen_invalid_transition`), then inactive non-S13/S14 → `lab.specimen_inactive` (409, CR-C5-005, 02-TRD §5).
- Review fix 2: R6 fails closed — missing `verifiedBy`/`approvedBy` or equal ids → `lab.self_approval_forbidden` (S-02).
- [CONV] Transitions as data tables keyed by (from,to); `null` from = absent (S1/R1). Roll-up = min over non-cancelled results; roll-down only via S15.
- [CONV] `assertResultValueEditable('verified')` throws result_invalid_transition (value change via R5 first). Spec silent.
- Open: resulted + pending roll-down to in_process not done (spec silent). T-02-ruling.md present but concerns C1 infra, not T-02 — ignored.

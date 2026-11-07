# T-02 impl (C5 writer)
- Files: `services/api/src/modules/lab/domain/{specimen.state,result.state,rollup}.ts` (pure, errors via core `LimsError`, codes already in contracts/errors.yaml).
- Result: domain tests 98/98 pass (`T-02-verify.cmd` command); `tsc --noEmit` 0 errors. No lint script in services/api.
- [CONV] Transitions as data tables keyed by (from,to); `null` from = absent (S1/R1). Inactive specimen: only S13/S14 pass.
- [CONV] Roll-up = min over non-cancelled results; received/aliquoted + any value emits S6 first; reported and off-ladder statuses never roll; roll-down only via S15 (approved→verified→resulted).
- [CONV] `assertResultValueEditable('verified')` throws result_invalid_transition (value change must go through R5 first). Not tested; spec silent.
- Open: resulted + pending roll-down to in_process not done (spec silent, per tester note). Multi-step roll-up jumps (e.g. received + all approved) emit every intermediate status.

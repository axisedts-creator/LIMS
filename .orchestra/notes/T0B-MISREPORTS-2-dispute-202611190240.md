# T0B-MISREPORTS-2 dispute (writer): 2 cases of probes/contract.probe.test.ts (AN-T21, P13) contradict the contract this task must deliver
Run: tests/analytics/T0B-MISREPORTS-2.pg.sh (LIMS_RUNS=1, PG17): 2843 passed, 2 failed, both below; commission.live 23/23, gates, registry.static, reportRegistry, schedule.dispatch.money green.
1. "export registry: ... the referral report column is flag-gated" pins `owners` (registry rows whose exportColumns hold net_billed_paisa) to EXACTLY [['referral_incentive', 'referralIncentiveReportEnabled']].
   contracts/openapi/analytics.yaml x-report-definitions two_level_commission (A39-1, T0C-MISREPORTS-1) has the column net_billed_paisa, and registry.static.test.ts pins
   `r.exportColumns == contract columns` for it. Now owners = [[referral_incentive, flag], [two_level_commission, flag]]: both behind the same flag, so the P13 intent
   (net billed never leaves the flag gate) holds; only the literal list is stale (written before A39). Fix: expect every owner to carry flag referralIncentiveReportEnabled,
   or list ['two_level_commission', 'referralIncentiveReportEnabled'] too.
2. "in C8 source (non-test), net_billed_paisa appears only in ..." allow set lacks service/misReports.service.ts, the SQL of the A39 report that must output that contract column
   (it is already on the c8 no-commission allow list for the same reason). Fix: add 'service/misReports.service.ts' to `allowed`. I did not dodge the scan (e.g. building
   the name from the definition at runtime): that would hide the column from the gate instead of reviewing it.
Precedence: contract (03/T0C) > this AN-T21 probe; no assertion of the T0B-MISREPORTS-2 tests is affected. Code is implemented and otherwise green; nothing else is open here.

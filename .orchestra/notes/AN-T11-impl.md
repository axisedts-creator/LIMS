# AN-T11 impl (writer)
Files (analytics/): handlers/{getTestsDoneReport,getQualityIndicatorsReport,getDeliveryReport,getInterfacesReport}.ts + index.ts wiring; service/reports.service.ts (+testsDone, qualityIndicators, delivery, interfaces); repository/rollups.repo.ts (+7 row readers, checkScope exported); NEW repository/sourceViews.repo.ts (listAgentStatus); NEW domain/columns.ts; mappers/reports.dto.ts (+4 DTOs).
Tests (after ruling fixed boot.test.ts): whole analytics dir 853 pass, 0 fail, 5 skipped. tsc: no errors in analytics. No impl change needed.
[CONV] constants in domain/columns.ts (tests mock rollups.repo with functions only). Tests-done has no centre filter: handler drops centre_id/branch_id (scope = caller's). Bp via min(1e6, max(0, ratioBp ?? 0)). Median kept only for single-source day (SQL: count(*)=1); totals omit median.
[CONV] assumptions from tester note adopted (default group_by, `unspecified` reason, failure_share denominator, addendum counted in released not amended, unknown filter ids -> 404).
Open: freshness[] still empty (AN-T04 wiring); SQL not run against a real DB (no C5/C6/C7 views yet); full-repo lint not run.

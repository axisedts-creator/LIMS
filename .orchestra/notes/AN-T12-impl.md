# AN-T12 impl (writer)
Files: repository/tat.repo.ts (new, tatRows), handlers/getTatReport.ts (new) + handlers/index.ts, service/reports.service.ts (tat, tatFilters), mappers/reports.dto.ts (toTatReportDto), domain/columns.ts (TAT_SEGMENTS), repository/rollups.repo.ts (export int).
Result (after ruling seed fix, no impl change): 3 files / 91 tests pass. tsc: 0 errors in src/modules/analytics (pre-existing errors in contracts/ports + shared-ts only).
[CONV] bs_month: service asks the repo per B.S.-month sub-range with group_by none (medians never merged). Repo groupBy has no bs_month.
[CONV] group_by none -> one row per requested segment (n 0, stats omitted); other group_by -> no empty rows; NULL group key -> key 'none', label 'No centre/branch/priority/specimen type'.
[CONV] Filter validation (segment <=5 enum, priority enum, specimen codes = _common Code pattern <=20, branch ids <=20 + core.branches membership -> 404) runs before any read.
Open: freshness[] stays [] (envelope [CONV]); real-DB SQL not run (no live DB in this lane).

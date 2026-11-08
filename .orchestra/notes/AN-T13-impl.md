# AN-T13 impl (writer)
Files: service/pending.service.ts (new), handlers/getPendingTests.ts (new), handlers/index.ts (+2 entries), mappers/reports.dto.ts (toPendingSummaryDto, toPendingItemsDto), repository/sourceViews.repo.ts (pendingSummaryRows, pendingItems), repository/rollups.repo.ts (backlogRows).
Tests: the 4 AN-T13 files 98/98 pass. Analytics suite 1244 pass, 2 fail: `__tests__/boot.test.ts` IMPLEMENTED list lacks getPendingTestsSummary/listPendingTests (test file, not mine to edit; tester/reviewer must add them, as AN-T12 did for getTatReport). tsc: no errors in modules/analytics (pre-existing ones are in contracts/, packages/). eslint not installed in services/api, not run.
[CONV] centre predicate sent only when centre_id/branch_id given (value = resolved scope list, [] = nothing); cursor = base64url {a,i}, max 512; ties order_item_id ASC; absent optionals omitted.
[CONV] freshness[] = pending_items (live) only; report_backlog freshness waits for the freshness service. Unknown department_id/processing_branch_id -> 404.
Open: real-DB SQL/RLS on lab.v_pub_pending_items and real statement_timeout not testable here (57014 propagates raw; core maps to 503).

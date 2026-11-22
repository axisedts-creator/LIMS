# T0D-FIX-9 left (writer)
- Same fault as previewPrintProfile, outside the file budget: `services/api/src/modules/reporting/service/print.service.ts:33` workingCentre() (previewReportTemplate, createBulkPrint) reads `c.centreId ?? c.actor.centreId`, which the real pipeline ctx never sets -> likely 500 on every live call. Fix shape: reuse the previewCentre() rule from printProfile.service.ts.
- Bench (`/inventory/bench`) and transfers (`/inventory/transfers`) pages still read reason lists through soft() (silent empty list on failure); the builder path is now contract-correct, but the visible-failure rule is applied only on the wastage page. Follow-up: switch them to softOr() like wastage/page.tsx.
- No data-side cause found for the four failures (all four were code).

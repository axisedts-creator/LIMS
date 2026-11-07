# C6-T06 impl (writer)
Files: services/api/src/modules/reporting/domain/document.ts (ReportDocument types per TRD §4.3 + pure buildReportDocument), service/assembly.service.ts (assembleDocument(ctx, input): port reads per TRD §4.3 Sources, then the builder). Reuses flags.ts / version.ts.
[CONV] getTest asOf = latest approvedAt of the test's included results; comment codes resolved per result group (departmentId + asOf), ≤50/call; getSignatories ≤20 ids/call (approvers ∪ nominees).
[CONV] Block key = department + panel heading (package member test -> nested clinical panel name, else test name); subgroups by first appearance in analyte sortOrder; empty tests skipped; amendment notes only when kind = amended (rule 0 note first).
[CONV] AssetRef.mimeType made optional: IdentityPort.Signatory carries no mime type (render worker learns it with the bytes). Branding logo/letterhead refs not set (settings carry ids, no sha256) — open for T08/T07.
Open: line images [] and block comments [] (instrument attachments = T08); comment texts keyed by code only (ponytail note in assembly.service.ts).
Tests: verify.cmd set 71/71 pass; tsc clean for both files. Reporting suite 688/689: repository.static fails on service/reports.service.ts inline SQL (pre-existing T04 file, not touched). eslint not installed in workspace — not run.

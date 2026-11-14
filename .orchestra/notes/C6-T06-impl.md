# C6-T06 impl (writer)
Files: services/api/src/modules/reporting/domain/document.ts (ReportDocument types per TRD §4.3 + pure buildReportDocument), service/assembly.service.ts (assembleDocument(ctx, input): port reads per TRD §4.3 Sources, then the builder). Reuses flags.ts / version.ts.
[CONV] getTest asOf = latest approvedAt of the test's included results; comment codes resolved per result group (departmentId + asOf), ≤50/call; getSignatories ≤20 ids/call (approvers ∪ nominees).
[CONV] Block key = department + panel heading (package member test -> nested clinical panel name, else test name); subgroups by first appearance in analyte sortOrder; empty tests skipped; amendment notes only when kind = amended (rule 0 note first).
Review fixes: printCriticalLabel is a top-level AssemblyInput/BuildDocumentInput field (reporting.settings, not TenantSettings); commentTexts keyed `${departmentId}|${code}`.
[CONV] AssetRef.mimeType optional — CR-C6-023 filed (.orchestra/cr/C6-T06.md). Branding logo/letterhead refs not set (settings carry ids, no sha256) — open for T08/T07.
Open: line images [] and block comments [] (instrument attachments = T08).
Tests: verify.cmd set 75/75 pass; tsc clean for reporting. Reporting suite 692/693: repository.static fails on service/reports.service.ts inline SQL (pre-existing T04 file, not touched). eslint not run (not installed).

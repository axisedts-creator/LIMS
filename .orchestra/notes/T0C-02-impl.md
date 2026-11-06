# T0C-02 impl (writer)
- Files: `contracts/ports/common.ts` + 13 ports (`BillingCommandPort`, `BillingPort`, `CatalogPort`, `EngagementPort`, `FrontdeskPort`, `IdentityPort`, `LabPort`, `NotificationPort`, `PaymentProviderPort`, `QualityPort`, `RenderPort`, `ReportingPort`, `SmartReportPort`), each IC §4 block verbatim; `contracts/package.json` devDep `typescript: 7.0.2`.
- [CONV] TypeScript 7.0.2 under [PIN-C0]; matches root package.json pin (ruling T0C-02).
- Tests: `npx vitest run` in contracts/ → 3 files, 250/250 pass (ports.test.ts 63/63, incl. tsc --noEmit).
- Open: ruling asks TS version be recorded in C0 02-TRD — `spec/` read-only for writer; needs spec owner.
- Open: `import('./generated/error-codes')` depends on T0C-05 output (test stubs it until then).

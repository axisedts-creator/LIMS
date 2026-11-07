Title: CR-C4-BL01b: reporting module reads LIMS_REPORTING_*/LIMS_CORE_ENV from process.env at import, so any default-modulesDir boot test fails
From chunk: C4            To owner: C6 (reporting)
Type: bug
Blocking? yes — BL-T01 (done-when "Core boots with module"); also breaks services/api/src/modules/lab/__tests__/boot.test.ts (2 failures on main 3ffb58b, same cause).
Problem: services/api/src/modules/reporting/index.ts:9 `export const config = loadReportingConfig(process.env)` runs at autoload. Boot tests that load the real modules dir and pass env only to core loadConfig() throw
  `config: LIMS_CORE_ENV must be one of dev|ci|staging|production` (reporting/config.ts:46), then "module reporting: index.ts exports no manifest". Billing code is not involved; the billing boot assertion cannot pass while reporting throws at import.
Proposed change (exact): either (a) make reporting config lazy (call loadReportingConfig on first use, not at import), or (b) C6 adds a vitest setup (services/api vitest config) setting LIMS_CORE_ENV=ci and LIMS_REPORTING_OTP_HMAC_KEY_FILE to a synthetic 32-byte temp file for all test runs.
Backward compatible? yes. Tenant/security impact: none (REQ-SEC-128/136 checks unchanged in production).
Alternatives considered: billing/lab tests setting process.env themselves (tests are frozen for the debugger role; each module test would repeat it).
Tests that will prove it: billing boot.test.ts "bootstrap resolves and every billing operation is mounted" and lab boot.test.ts turn green.

# API-T01 dispute
- Failing: boot.test.ts "boot against the real repo" (2 tests). Cause is outside C7: `modules/reporting/index.ts:9` runs `loadReportingConfig(process.env)` at import; autoload imports every module.
- Spec: C6 02-TRD.md line 837 (`LIMS_REPORTING_OTP_HMAC_KEY_FILE` required, >=32 bytes) + REQ-SEC-128/136 make that config fail-closed; C6 CR (`C6-T01.resolved-202611071917.md`) rejected lazy/fail-open loading and prescribes tests pass an isolated `modulesDir`.
- The instruments test boots default modulesDir with no process.env module config, so it can only pass by (a) editing the test (modulesDir fixture or env setup) or (b) weakening C6 config. Neither allowed for debugger; no C7-owned code change can fix it.
- Needed: tester fixes boot test (set LIMS_CORE_ENV=ci + OTP key file in process.env, or use fixture modulesDir), or verify.cmd exports them. CR-C7-001 (.orchestra/cr/API-T01.md) is moot/should be withdrawn.

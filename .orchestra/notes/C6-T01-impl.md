# C6-T01 impl (writer)
Files: services/api/src/modules/reporting/{config,permissions,index}.ts, services/worker/src/jobs/reporting/index.ts.
- config: loadReportingConfig(env), frozen; ints = digits only, ≥1; TTL ≤600, attempts ==5, key file ≥32 B (contents never in errors); ALLOW_REAL_PROVIDERS true|false, true iff LIMS_CORE_ENV=production (NODE_ENV ignored).
- [CONV] LIMS_REPORTING_OTP_HMAC_KEY_FILE required in every env (spec gives no default); LIMS_CORE_ENV validated against CORE_ENVS.
- index: config loaded at import (boot fails on bad config); every reporting.yaml operationId -> body-less { status: 501 } [CONV, no 501 code in errors.yaml]; portalSession resolver stub fails closed.
- worker: empty tasks/subscriptions/crontab.
Retest (after LEAD AUTO 2026-11-07T19:17:46 boot.test.ts fix): verify cmd api 154/154 + worker 4/4 pass; api tsc clean. No impl change needed.
Open: first run under load showed 1 flaky failure (32 s run); rerun green in 10 s — load-related timeout, not logic.

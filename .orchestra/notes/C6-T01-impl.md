# C6-T01 impl (writer)
Files: services/api/src/modules/reporting/{config,permissions,index}.ts, services/worker/src/jobs/reporting/index.ts.
- config: loadReportingConfig(env), frozen; ints = digits only, ≥1; TTL ≤600, attempts ==5, key file ≥32 B (contents never in errors); ALLOW_REAL_PROVIDERS true|false, true iff LIMS_CORE_ENV=production (NODE_ENV ignored).
- [CONV] LIMS_REPORTING_OTP_HMAC_KEY_FILE required in every env (spec gives no default); LIMS_CORE_ENV validated against CORE_ENVS.
- index: config loaded at import (boot fails on bad config); every reporting.yaml operationId -> body-less { status: 501 } [CONV, no 501 code in errors.yaml]; portalSession resolver stub fails closed.
- worker: empty tasks/subscriptions/crontab.
Results: C6-T01 tests 136/136 pass; api tsc clean; worker suite 133/133.
Open: core boot.test.ts 5 sample-module cases now fail (boot real modules dir without reporting env) -> .orchestra/cr/C6-T01.md (C0-0D). Full api run also shows load-related 5 s timeouts in other core tests; they pass in isolation.

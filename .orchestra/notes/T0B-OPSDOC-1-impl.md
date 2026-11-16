# T0B-OPSDOC-1 impl (writer) — dispute resolved (ruling TESTS_WRONG, docRows fixed by tester); no code change needed after ruling
- NEW docs/runbooks/environment.md: 173 rows (144 scanned names + hand-added LIMS_PAYMENTS_*/LIMS_ENGAGEMENT_* built from a prefix, invisible to the scan); names only; 22 required.
- core/health.ts: REQUIRED_ENV (= doc required rows); readiness adds degraded + sorted `missing_env` (names only, only when non-empty); down still 503.
- core/bootstrap.ts: option `env`; main.ts passes process.env. [CONV] default = no env check, so existing health tests under the test env are unchanged.
- contracts/openapi/core.yaml Readiness: optional `missing_env` string array (path owned by C0-0C; additive, schema is closed) — lead to confirm.
- [CONV] worker/web-only names `optional` (API readiness cannot see their process). LIMS_CORE_DATABASE_URL `optional` (already reported as checks.db down; ruling point 4 accepts).
- Ran after ruling: env-doc + health-env + health tests: 3 files, 34/34 pass; tsc shows no errors in health/bootstrap/main. render.yaml untouched.
- Open: full suite/lint not run; scan cannot see run-time-built names.

# T0B-OPSDOC-1 impl (writer) — review fixes applied; BLOCKED on CR-C0-T0B-OPSDOC-1-001 (C0-0C)
- NEW docs/runbooks/environment.md: 173 rows (144 scanned + hand-added prefix-built LIMS_PAYMENTS_*/LIMS_ENGAGEMENT_*); names only; 22 required.
- core/health.ts: REQUIRED_ENV (= doc required rows); readiness adds degraded + sorted `missing_env` (names only, when non-empty); down still 503.
- core/bootstrap.ts: option `env`; main.ts passes process.env. [CONV] default = no env check, so existing health tests stay green.
- Review item 1: reverted contracts/openapi/core.yaml hunk (C0-0C ONLY); filed .orchestra/cr/T0B-OPSDOC-1.md asking C0-0C for the optional `missing_env` in Readiness. Item 2 (scan comment) done by tester.
- [CONV] worker/web-only names `optional` (API readiness cannot see their process); LIMS_CORE_DATABASE_URL `optional` (ruling point 4).
- Ran: env-doc + health-env + health: 34 tests, 27 pass, 7 fail — all in health-env (Readiness closed => 500, and the static core.yaml pin). Expected until the CR merges.
- Open: CR merge by C0-0C (or an LD authorising this lane); full suite/lint not run.

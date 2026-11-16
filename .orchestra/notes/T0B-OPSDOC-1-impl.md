# T0B-OPSDOC-1 impl (writer) — BLOCKED on dispute (health-env.test.ts docRows strips `_`), see -dispute.md
- NEW docs/runbooks/environment.md: 173 rows (all 144 scanned names + hand-added LIMS_PAYMENTS_*/LIMS_ENGAGEMENT_* built from a prefix, invisible to the scan); names only; 22 required.
- core/health.ts: REQUIRED_ENV (= doc required rows); readiness adds degraded + sorted `missing_env` (names only, only when non-empty); down still 503.
- core/bootstrap.ts: option `env`; main.ts passes process.env. [CONV] default = no env check (not process.env as the tester assumed): else existing health/health-checks tests under the test process env would change.
- contracts/openapi/core.yaml Readiness: optional `missing_env` string array (path owned by C0-0C; additive, needed because the schema is closed) — lead to confirm.
- [CONV] worker/web-only names are `optional` (API readiness cannot see their process; the row says what their process does). LIMS_CORE_DATABASE_URL `optional` (already shown as db down; see dispute note 2).
- Ran: env-doc 6/6 pass; health-env 7/10 fail (test defect); with 1-line parser fix 10/10; health, health-checks, observability green. render.yaml untouched.
- Open: full suite/lint/typecheck not run; scan cannot see run-time-built names.

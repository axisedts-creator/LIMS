APPROVE
# SEC-DEPS-1 review round 2 (reviewer), diff 65e337e9a..44df4d2e9

Round 1 item 1 fixed by tester c6adbe34a: `tools/lint/tests/ci-workflows.test.mjs:200-210` now strips only the one step whose `continue-on-error: true` is directly followed by `run: pnpm audit --audit-level=high` (cites LD-239), asserts at most one such step, and keeps the `continue-on-error`, `|| true` and `|| exit 0` asserts for the rest of pr.yml. The regex is line-anchored, so it does not match the blocking `pnpm audit --prod --audit-level=high` step; pr.yml step names and commands were not changed to dodge it.

Re-run by me: `node --test tools/lint/tests/ci-workflows.test.mjs tests/security/sec-deps1.test.mjs` gives 105 pass, 1 fail. The failure is `supabase-pin`, which existed before this task and is in files this diff does not touch. The gate test passes and sec-deps1 passes 18/18.

Round 1 checks are unchanged and still hold: ajv >= 8.18.0 and yaml >= 2.8.3 in every lock resolution; the blocking prod audit and the non-blocking full audit are in pr.yml; prism-cli is kept with CR SEC-DEPS-1.1; only owned paths are edited; no secrets, no PHI; nothing invented.

Not verified: real `pnpm audit` (needs network); full `pnpm install --frozen-lockfile` (local run stops at ERR_PNPM_IGNORED_BUILDS); `@lims/web#typecheck` red (writer notes say it was not shown to be pre-existing against a clean HEAD).

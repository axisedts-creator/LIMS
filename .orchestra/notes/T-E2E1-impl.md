# T-E2E1 impl — writer
- Changed: `.github/workflows/nightly.yml` only (new step "C16 patient engagement E2E journeys", after `test:e2e`, before isolation; runs `pnpm exec vitest run tests/e2e/engagement-journey.e2e.ts`).
- [CONV] Env from `vars.E2E_BASE_URL`, `vars.E2E_TENANT_CODE`, `secrets.E2E_STAFF_TOKEN_A`; no literal token, no continue-on-error, no `|| true`; token never echoed.
- Tests: `node --test tests/e2e/engagement-journey.static.test.mjs` -> 11/11 pass.
- Open: the e2e journey was NOT run (no compose stack here).
- Open: test-support routes (CR `.orchestra/cr/T-E2E1.md`) must be mounted in compose by C0-0C/C0-0D; until then the nightly step fails by design.
- Open: repo variables/secret above must be created by the owner; the staff token is not minted in the job.
- Open: no vitest config/dependency check done for root-level `pnpm exec vitest` (not an owned path).

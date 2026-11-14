# T-E2E1 impl — writer
- Changed: `.github/workflows/nightly.yml` only (new step "C16 patient engagement E2E journeys", after `test:e2e`, before isolation; runs `pnpm exec vitest run tests/e2e/engagement-journey.e2e.ts`).
- [CONV] Env from `vars.E2E_BASE_URL`, `vars.E2E_TENANT_CODE`, `secrets.E2E_STAFF_TOKEN_A`; no literal token, no continue-on-error, no `|| true`; token never echoed.
- Tests: `node --test tests/e2e/engagement-journey.static.test.mjs` -> 11/11 pass.
- Open: the e2e journey was NOT run (no compose stack here).
- Open: test-support routes (CR `.orchestra/cr/T-E2E1.md`) must be mounted in compose by C0-0C/C0-0D; until then the nightly step fails by design.
- Open: repo variables/secret above must be created by the owner; the staff token is not minted in the job.
- Re-review pass: CR `.orchestra/cr/T-E2E1.nonblocking.md` updated (POST /events gains `aggregate_seq`, envelope.aggregate built by route; /scenarios 201 gains `specimen_type_code`). nightly.yml unchanged. Static 11/11 pass.
- Review pass: all 4 review items target tests/CR (handled by tester); no impl change. Static suite re-run: 11/11 pass. Open: CR needs `aggregate_seq` on POST /events + `centre_id`,`specimen_type_code` on /scenarios 201 (lead).

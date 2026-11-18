Title: CR-C1-902: residual red checks outside C1 ownership found during the Nepal cutover (one entry per owner)
From chunk: C1 (nepal)    To owner: see each entry
Type: bug
Blocking? `pnpm -s verify` and the infra static suite stay red until these land. None blocks bringing up the synthetic staging host.

1. To C0-0A: `tools/lint/check-supabase-pin.ts` (lint test #244 "supabase-pin") expects `<repo>@sha256:<digest>` lines in the lock. C1's `infra/compose/supabase/upstream/UPSTREAM.lock` stores `images.<svc>.{image,tag,digest}` (08 A25 D-208: "UPSTREAM.lock (C1) is the single source of image digests"). Proposed: parse the YAML `images:` map (image + "@" + digest). Test: #244 green against the committed lock.
2. To C0-0A/C0-0D: lint #307 "build smoke" runs `pnpm -w build`. In a container where pnpm 12 runs as its SEA binary (`@pnpm/exe`), turbo's child spawn fails with "Exec format error"; the same `turbo run build` passes when started directly. Not a repo defect as far as the lead can tell. Re-run in CI before acting.
3. To C0 (root `.env.example` owner): infra static `test_t0d_dep01_images.RealEnvExample.test_env_example` wants a required/optional comment on the STORAGE_* lines (~206-212) and the api-group variables `LIMS_CORE_AUTHZ_MODE`, `LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS`.
4. To C10 (contracts/openapi/micro.yaml owner) + C0-0C: `contracts/openapi/micro.yaml:6352` has a bare `- =` that PyYAML rejects (tag/flow ambiguity), so `infra/ci/gen-routes.sh` exits 4 and `test_t13_edge.GenRoutesTest.test_committed_yaml_equals_generator_output` fails. Proposed: quote the value (`- "="`).
5. To C3 (and every module whose `ops/alerts.yaml` was imported): `test_t21_module_rules.ImportScriptTest.test_repo_default_run_is_clean_regardless_of_cwd`: the committed `infra/monitoring/rules/imported/` drifts from module sources, e.g. `services/api/src/modules/catalog/ops/alerts.yaml:14` `CatalogNoPriceSpike` severity `ticket`, which the importer rejects (allowed: page|warn). Fix the source severity, then re-run `infra/ci/import-rules.sh`.
6. To founder/C1 (spec value needed): `test_t34_agent_release` ×2: the Authenticode signing tool version is empty in the role defaults, and the `infra/THIRD-PARTY-OPS.md` row still reads "C1 pins in T-34". No version is in the spec; not invented.
7. To C6: `apps/portal/Dockerfile` does not exist but `infra/ci/build.sh` lists it (build.sh now stops with a message). To founder: the Node base image/variant for `NODE_BASE_IMAGE` (see NEPAL-node-base-image.md).
8. To C0-0B: 110 pgTAP files red at cycle 1 (see infra/cutover/STATUS.md). The 15 isolation-probe failures are generator bugs (NEPAL-leak-C13/C16/C17). The rest (payments C15 behaviour 55, `T0B-08_step9_fixed` 48 × E42501 on migration_staging, engagement redeem 14, C10/C11 behaviour 12 each, ...) are undiagnosed.

Backward compatible? yes (each is a local fix). Tenant/security impact: none added; item 8 must be triaged before any real data.
Tests that will prove it: the named test of each entry turns green.

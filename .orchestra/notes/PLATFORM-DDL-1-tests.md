# PLATFORM-DDL-1 tests (tester)
- `db/tests/identity/PLATFORM-DDL-1_policies.test.sql` pgTAP, NOT runnable in lane: `bash db/tests/run-suites.sh db/tests/identity/PLATFORM-DDL-1_policies.test.sql` (docker). A catalog of 19 s5.3 policies, B per table/command platform allowed vs tenant refused, C training_mode, D tenant_contract_acceptances (FORCE RLS, append-only, CHECKs), E provisioning inserts.
- `services/api/src/modules/identity/__tests__/platform-ddl-1.static.test.ts` reads both migrations, db/policies/identity.sql, tables.yaml, isolation registry (22 policies 1:1, additive-only, grants INSERT+SELECT only).
- `tenant.service.test.ts` + `tenant.helpers.ts` (edited): seedIrdAnnexes must run OUTSIDE withTenantScope (platform claims), after the core.tenants insert, same tx. Commits to LD-223 option 3 (platform INSERT; no tenant INSERT policy, no CR).
- Run all: `.orchestra/notes/PLATFORM-DDL-1-verify.cmd` (vitest on 4 files, then `node db/tools/check-registry.ts`).
- Now: 12 static + 17 tenant.service + 2 tenant.integration fail (migrations missing / annex insert inside tenant scope); tenant.handlers passes; check-registry ok.
- NOT in verify: `gen-isolation-probes.ts --check` is already stale at baseline (homecollection, migration_staging, _registry). Writer must regenerate; the static registry test then passes.

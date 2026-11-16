# T0B-SESSRANGE-1 tests (tester, after LD-306 reset)
- Vitest (via package): `identity/__tests__/session-range.contract.test.ts` (3 schemas 15..30 / 1..12, ajv 400-at-field checks, response schemas) and NEW `session-range.checks.test.ts` (OpenAPI min/max of both fields == the CHECKs in 20261105001300_identity__create_identity_schema.sql; no newer migration names the two checks).
- DELETED (LD-306): `session-range.migration.test.ts`, `db/tests/identity/T0B-SESSRANGE-1_tenant_settings_ranges.test.sql` (also removes the pgTAP SET LOCAL ROLE leak).
- Run: `.orchestra\notes\T0B-SESSRANGE-1-verify.cmd` (also runs auth.session-clamp, settings.service, settings.ranges).
- Now: 287 pass, 1 fails for the right reason: "no newer migration redefines the checks" because the writer's `db/migrations/20261117010000_identity__narrow_tenant_settings_session_ranges.sql` still exists. WRITER MUST DELETE that file (not a test path, tester cannot).
- Review file `T0B-SESSRANGE-1-review.md` did not exist; ruling.md (CR_NEEDED) is superseded by LD-306, its item 4 (pgTAP RESET ROLE) is moot (file deleted).
- Findings 1-3 of the earlier note stand (service already 422; web SettingsScreen hard-codes 15..30/1..12; platform TenantDetail.tsx:145-146 has no min/max, web lane).

APPROVE

Reviewed 52910888..HEAD (77dd4417b tester, 79012e01d writer) against LD-304 and LD-306.
- LD-306 done: deleted db/migrations/20261117010000_identity__narrow_tenant_settings_session_ranges.sql, session-range.migration.test.ts and the pgTAP T0B-SESSRANGE-1_tenant_settings_ranges.test.sql. `git grep` (excluding .orchestra) finds no reference to any of them.
- New session-range.checks.test.ts reads tenant_settings__idle__ck (15..30) and tenant_settings__absolute__ck (1..12) from 20261105001300 lines 475-476. It asserts that TenantSettingsDto, PlatformTenantSettingsDto and TenantSettingsPatch have the same min/max, and that no newer migration redefines either check. Names are copied exactly from the spec.
- Contract: identity.yaml at lines 5807-5808, 5874-5875 and 5939-5940 is 15..30 and 1..12. Service: settings.ranges.ts lines 8-9 are the same. Untouched: sessions__idle__ck and sessions__absolute__ck, rate limits, MFA and password rules.
- No new RLS policy, no migration, no PHI, no secrets. Changed paths: identity tests and .orchestra notes/cr only.
- CR-C0-LOGIN-1 is marked RULED (LD-304, amended by LD-306). The founder needs no push-cloud.ps1 step.
- Ran T0B-SESSRANGE-1-verify.cmd: 5 files, 288/288 pass.
- Not a defect, for the web lane: platform TenantDetail.tsx:145-146 has no min/max (tester finding 3).

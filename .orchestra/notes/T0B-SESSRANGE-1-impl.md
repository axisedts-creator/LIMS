# T0B-SESSRANGE-1 impl (writer, after LD-306 reset)
- Deleted db/migrations/20261117010000_identity__narrow_tenant_settings_session_ranges.sql (LD-306: done_when item 3 withdrawn; CHECKs exist since 20261105001300:475-476).
- Contract (identity.yaml 15..30 / 1..12) and service validation unchanged from earlier round (already narrowed, LD-304).
- .orchestra/cr/T0B-LOGIN-1.nonblocking.md marked RULED (LD-304, LD-306).
- [CONV] no migration, no policy, no cloud apply: founder needs NO push-cloud.ps1 step for this task.
- Verify: T0B-SESSRANGE-1-verify.cmd -> 5 files, 288/288 pass.
- Open (web lane): web SettingsScreen hard-codes 15..30/1..12; platform TenantDetail.tsx:145-146 has no min/max.

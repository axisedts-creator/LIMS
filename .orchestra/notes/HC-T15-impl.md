# HC-T15 impl (H16 listPhleboDevices, H17 requestDeviceWipe)
- Files: `handlers/listPhleboDevices.ts`, `handlers/requestDeviceWipe.ts`, `deviceAdmin.service.ts` (new), `repository/devices.repo.ts` (+`listDevicesPage`), `index.ts` (2 stubs replaced).
- Run: `HC-T15.pg.sh` (docker up) 67/67 pass (list, wipe, static) after arbiter ruling `HC-T15-ruling.md` revised list.test.ts; no impl change needed.
- [CONV] gate = `IdentityPort.assertRole(device.manage)` first (403 forbidden / mfa_required), then path id, If-Match (428/400 as H19), body, `wipe_reasons` lookup (`other` needs text), then row.
- [CONV] H17: unknown/cross-tenant 404 `common.not_found`; wiped/signed_off/stale version 409 `common.version_conflict`; repeat on wipe_requested at current version = 200 no-op (first reason kept); race loser 409.
- [CONV] H16: keyset (registered_at DESC, id DESC), cursor `{v:1,k,i}` -> `common.invalid_cursor`; one `memberships.list` per page; lookup failure -> placeholder `—`.
- Open: `wipe_requested_by` = `ctx.actor.id` (user id; no FK). A2 snapshot `device_command: wipe` belongs to HC-T11. Idempotency-Key = core pipeline, untested.

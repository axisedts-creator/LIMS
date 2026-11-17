# HC-T10 impl (A1 registerPhleboDevice, A5 signOffPhleboDevice)
- Files: `device.service.ts`, `handlers/{registerPhleboDevice,signOffPhleboDevice}.ts`, `mappers/device.mapper.ts`, `index.ts` (wired), `repository/devices.repo.ts` (+`insertDeviceIfAbsent`), `settings.service.ts` (+1-line export `settingsDefaults`).
- Result: `HC-T10.pg.sh` -> 3 files, 42/42 tests pass (PG17 docker); devices/settings/visits/repository static tests pass.
- [CONV] A1 insert = `ON CONFLICT (id) DO NOTHING` then tenant re-read (201 new / 200 same membership / 409 device_not_registered otherwise); no unique violation, no aborted tx under races.
- [CONV] A5 re-reads and retries (<=5) on a lost optimistic update; binding check before seq check; wipe_requested -> 409 unsynced_changes; signed_off -> 204 no-op; wiped/unknown/other -> 409 device_not_registered.
- [CONV] A1 lazily creates the settings row (P-22, same defaults as H18/H19) to read min_app_version; the 426 test relies on a row existing from an earlier A1 call in the same file.
- Open: own signed_off/wiped row on A1 -> 409 device_not_registered (not asserted; app must use a new device_id). os/app_version not refreshed on re-register. Touched devices.repo.ts / settings.service.ts outside the brief's file list (additive only).
- Open: `__tests__/boot.test.ts` IMPLEMENTED list is stale (omits HC-T08 ops + A1/A5), so its stub tests fail; test file, not edited. `tsc --noEmit` errors are pre-existing (contracts/ports imports).

# HC-T24 spike (TRD §7.5, review m#36)
Host-only session: no Android device or emulator was available, so neither question could be answered by measurement.
1. Does Android `SystemClock.elapsedRealtime()` include deep sleep? **UNVERIFIED.** Used in `MainActivity.kt` (channel `np.lims.phlebo/platform`, method `monotonicMs`). Android docs say it counts time in deep sleep, but no device test was run. To verify: record the value, lock the phone ~30 min in airplane mode, compare the delta with wall time.
2. Is `Settings.Global.BOOT_COUNT` readable by a normal app? **UNVERIFIED.** Used in `MainActivity.kt` (method `bootId`, formatted `b-<10 digits>`); `SettingNotFoundException` surfaces as channel error `boot_id_unavailable`, which fails anchor/batch creation loudly. To verify: read it on API 26+ devices, reboot, confirm it increments by 1.
iOS: no channel written (UNVERIFIED which clock includes sleep; anchors are valid within one app process only, TRD §7.5 [DECISION]).

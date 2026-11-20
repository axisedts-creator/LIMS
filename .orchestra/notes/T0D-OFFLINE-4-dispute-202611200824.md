# Dispute T0D-OFFLINE-4 (debugger, 2026-11-20)
verlevel1.settings.test.tsx:290 opens with CONFIG_ONLY (lab.config.manage + verification_policy.read) and has no handler for GET /v1/lab/settings, so the General tab read fails while the test clicks the "Verification levels" tab.
GeneralTab.tsx:80 (T0D-UISETTINGS-1; its comment at line 71 says the tabs never remount) swaps SettingsForm for SettingsSection on a read error for canManage users, so the click is lost.
lab-t29.settings.test.tsx "a failing read (403) shows the error text in an alert ... and no Save button" forbids keeping SettingsForm on error; `!loaded` instead breaks lab-t29 delta/reason tabs and lab-t25 holds.
Fix belongs to T0D-UISETTINGS-1 (e.g. SettingsForm with a hideable save bar in one tree). Unrelated to OFFLINE-4: offline4 58/58, offline1-3, c5-t20, lab-t10, printcfg1, bl-t23, rs-c2 green.

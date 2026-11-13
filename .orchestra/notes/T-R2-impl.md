# T-R2 impl (W9 Reminders) — review round 2, 2026-11-12. Run: `.orchestra\notes\T-R2-verify.cmd`
- Files (apps/web/src/app/(staff)/engagement/reminders/): reminders.server.ts, page.tsx, RemindersView.tsx. CR: .orchestra/cr/T-R2.md (R1 `kind?`, non-blocking).
- R1 range: URL keeps dates; R1 gets instants = Asia/Kathmandu day bounds (00:00:00.000 / 23:59:59.999 +05:45). Cap = 92 calendar days inclusive (difference ≤ 91) in server and view.
- Reasons: from T3a GET /v1/engagement/coded-sets/reminder_reasons (listReminderReasons); hard-coded REASONS deleted.
- [CONV] Kind: not sent to R1; page filters the returned page by kind until CR T-R2 lands (pages can come back short).
- 409 common.version_conflict: Banner "Someone else changed this. Reload to see the latest." + [Reload] (router.refresh).
- Test runs: vitest worker start keeps timing out on the loaded machine ("Failed to start forks worker"); see final result below.
- Open: R1 Reminder has no patient_display (fallback "Patient …<id tail>"); R4 panel not built (T-P4 missing).

# T-R2 impl (W9 Reminders) — tests green: 28/28 (2 files), `.orchestra\notes\T-R2-verify.cmd`, 2026-11-12
- Files (apps/web/src/app/(staff)/engagement/reminders/): page.tsx, RemindersView.tsx (client), actions.ts ('use server'), reminders.server.ts (R1/R2/R3 BFF). No code change this round; ruling (dialog role) fixed in tests.
- Flake: a cold first run timed out the first test (20 s; module import ~40 s on a loaded machine). The warm rerun passed in 59 s.
- [CONV] reasons = static g_cs_reminder_reasons seed in page.tsx (no coded-set read route); patient search reuses frontdesk F1 via searchPatientsAction; due-range filter = 2 text inputs (kit DateRangePicker commits on blur); kind filter forwarded though R1 lists no `kind` param.
- Open: R1 Reminder has no patient_display (page falls back to "Patient …<id tail>"); R4 panel not built (T-P4 missing).

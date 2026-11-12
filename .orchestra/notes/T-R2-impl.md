# T-R2 impl (W9 Reminders) — INCOMPLETE: not all tests verified green
- Files (apps/web/src/app/(staff)/engagement/reminders/): page.tsx, RemindersView.tsx (client), actions.ts ('use server'), reminders.server.ts (R1/R2/R3 BFF).
- Last full run (before final edits): 14 pass / 14 fail. Fails: 4 need role=alertdialog (see T-R2-dispute.md); 9 hit the 20 s timeout (slow env); axe 'region' x2 fixed after by wrapping in <section aria-label="Reminders"> (not re-run).
- Re-runs after the edits died at vitest "Failed to start forks worker" (machine overloaded) — Filters/axe/New-reminder fixes UNVERIFIED. Rerun `.orchestra\notes\T-R2-verify.cmd` on an idle machine.
- [CONV] reasons = static g_cs_reminder_reasons seed in page.tsx (no coded-set read route); patient search reuses frontdesk F1 via searchPatientsAction; due-range filter = 2 text inputs (kit DateRangePicker commits on blur, tests don't blur); kind filter forwarded though R1 lists no `kind` param.
- Open: R1 Reminder has no patient_display (page falls back to "Patient …<id tail>" if API omits it); R4 panel not built (T-P4 missing).

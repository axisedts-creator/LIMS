# T-R2 tests (W9 Reminders; US-EN-23.1–4; component + axe)
- Files: apps/web/src/app/(staff)/engagement/reminders/__tests__/{t-r2.reminders.test.tsx (jsdom+MSW+axe), t-r2.source.test.ts (static), vitest.t-r2.config.ts}.
- Run: `.orchestra\notes\T-R2-verify.cmd` (vitest via the root node_modules, config-scoped to this task only).
- Covers: columns/status text/Result mapping (4 suppression texts), cancel only for scheduled (AC-23.4), R3 If-Match, R2 body+Idempotency-Key+due ≥ now+1 h, ≤92-day filter, page→R1 params, no browser storage, axe x4.
- Seams ASSUMED (header of the .tsx): `RemindersView({reminders (Reminder+patient_display), permissions, reasons, searchPatients})`, `page.tsx`, `actions.ts` via serverFetch; row button "Cancel reminder"; dialog "New reminder"/"Create reminder"; group "Due date range".
- Not tested: R4 suggestions panel (T-P4 missing; US-EN-24.3 outside ACs); SMS dispatch/in-app/opt-out ACs 23.1–3 are API-side (T-R1), here only the UI rendering of their outcomes.
- Fails now: all (modules ../RemindersView and ../page do not exist).
- Review round 1 (tests only): R1 due_from/due_to must be ISO instants (Kathmandu day bounds, 92 calendar days inclusive); reasons via T3a coded-sets; Kind not sent to R1, rows filtered; 409 common.version_conflict Banner + Reload. alertdialog lookup accepts dialog (ruling).

CHANGES

Scope OK: only owned paths (help/*.md, docs/manual/billing/*.md, tester files). Every PageHeader helpKey has help; §11 neutral sentence, CBMS stub string (04-UI-UX L10 / TRD L546), `urn:lims:billing:export:v1` "not an IRD schema" are all present; no banned/overclaim wording; no PHI/secrets. bl-t23 vitest 25/25 passes (re-run by reviewer).

Defect: the help documents keyboard shortcuts that the billing screens do not have (writer's note admits they were not checked). §11 says help explains the screen's real "shortcuts", and the brief says "nothing invented". In code, only global `?` (core/shortcuts/registry.ts:3), button `Ctrl+Enter`, dialog `Esc` and react-aria tab arrow keys exist. No billing component passes `onRowAction` to DataTable, has a `/` filter-focus handler, or handles Page Up/Down.

1. apps/web/src/features/billing/help/audit_trail.md:16-17 – delete the `/` line and the `Page Down`/`Page Up` line.
2. apps/web/src/features/billing/help/cbms.md:22-23 – delete the `/` line and the "`Enter` – activate Retry on the highlighted row" line.
3. apps/web/src/features/billing/help/credit_parties.md:18-19 – delete the `/` line and the "`Enter` – open the highlighted party" line.
4. apps/web/src/features/billing/help/dues.md:20-21 – delete the `/` line and the "`Enter` – open the highlighted registration" line.
5. apps/web/src/features/billing/help/invoices.md:20-21 – delete the `/` line and the "`Enter` – open the highlighted invoice" line.
6. apps/web/src/features/billing/help/registers.md:17 – delete the `/` line.
7. apps/web/src/features/billing/help/worklist.md:17 – change to "`Ctrl+Enter` – submit the Reject or Resolve dialog." Approve opens a ConfirmDialog (FinanceWorklist.tsx:90-92) with no Ctrl+Enter button. Only Reject (L124) and Resolve (L153) have one.
(If BL-T20 later adds these bindings, the lines can come back in that task.)

TESTS_WRONG — the test asserts role="alertdialog", which the spec does not require
Change in apps/web/src/app/(staff)/engagement/reminders/__tests__/t-r2.reminders.test.tsx lines 162, 175, 184, 332:
replace `screen.findByRole('alertdialog')` with a lookup that accepts either role, e.g.
`await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))` (same pattern used elsewhere in the repo). Keep every other assertion as it is (title, reason select, confirm button, If-Match, axe).
Reasons:
- spec/chunks/C16-patient-engagement/04-UI-UX.md:31 — reason-coded actions use the kit `ConfirmDialog` with `requireReason`; it sets no ARIA role.
- spec/chunks/C0-foundation-contracts/04-UI-UX.md:221 — ConfirmDialogProps contract has no role prop or role requirement.
- spec/chunks/C0-foundation-contracts/04-UI-UX.md:95 — kit components get their ARIA behaviour from react-aria-components primitives; the kit ConfirmDialog (packages/ui/src/components/ConfirmDialog/ConfirmDialog.tsx:55) renders `Dialog`, so role="dialog".
- A grep of spec/ for "alertdialog" finds nothing, so the test adds a requirement the spec does not have.

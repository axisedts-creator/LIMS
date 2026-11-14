# T-R2 dispute: tests expect role="alertdialog" for the cancel ConfirmDialog
- Affected: t-r2.reminders.test.tsx lines 162, 175, 184, 332 (3 Cancel tests + 1 axe test).
- Fact: kit `packages/ui/src/components/ConfirmDialog` renders react-aria Dialog with the default role="dialog"; the spec (grep spec/) never says alertdialog; other repo tests accept either (`findByRole('alertdialog').catch(() => findByRole('dialog'))`).
- The writer may not edit the kit (not owned) nor the tests. Ask: tester changes those 4 lookups to accept role dialog or alertdialog.

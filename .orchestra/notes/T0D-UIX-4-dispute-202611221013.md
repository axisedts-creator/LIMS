# T0D-UIX-4 dispute (debugger)
Brief DONE WHEN (1): every raw `<table` in features/frontdesk becomes the kit DataTable; (6): "only tests that pinned the old markup change".
uix4.markup.test.ts forces RegistrationForm's cart table to DataTable. The kit DataTable is role=grid (packages/ui DataTable.tsx line 2), so these still ask for role "table" and fail:
- frontdesk/__tests__/fd-t13.keyboard.test.tsx:141 (`findByRole('table', { name: /tests|selected/i })`)
- frontdesk/__tests__/regscreen1.items.test.tsx:50 (`getByRole('table', { name: /selected tests/i })`)
- frontdesk/__tests__/regscreen2.order.test.tsx and regscreen2.drafts.test.tsx (same query, about 9 cases)
Fix needed in tests (tester role): query role 'grid' (name unchanged: "Selected tests"). Implementation not changed further. Stopped.

# T0D-CONTENT-1 dispute (debugger)
Only failing verify test: engagement/__tests__/t-l1.app-access.test.tsx:85 ("empty state ... Issue action still available") - getByRole('button', {name:/issue app code/i}) finds 2 buttons.
Not caused by T0D-CONTENT-1: AppAccess.tsx is untouched by it. Second button comes from T0D-EMPTYTBL-2 (f5467595a, AppAccess.tsx:201 + :223, LD-310/LD-336 "empty table repeats the action").
Two tests contradict each other: catalog/__tests__/emptytbl2.other.test.tsx:54 requires "Issue app code" repeated inside the empty table; t-l1:85 needs exactly one match. No impl change satisfies both.
Fix needs a test change (t-l1:85 -> getAllByRole, or emptytbl2:54 dropped); tester/lead decision. Debugger stops.

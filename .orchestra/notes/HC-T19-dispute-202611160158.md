# HC-T19 dispute (writer)
Test: `hc-t19.detail.test.tsx` > layout > "Tubes table: specimen type, container, …" (line 94: `within(card('Tubes')).getByRole('table')`).
Why wrong: 04-UI-UX §2.2 says the Tubes card is a `DataTable`. The kit `DataTable` (packages/ui, react-aria `Table`) renders `role="grid"` (see its header comment; hc-t18 and hc-t20 tests all use `getByRole('grid')`). `getByRole('table')` can never match it, and hc-t19.source forbids a raw `<table`. So the test cannot pass with the spec'd component.
Fix suggested: `getByRole('grid')` on line 94 (the columnheader / row / chip / scan assertions after it already hold: I checked them against the rendered grid). Line 128 (`queryByRole('table') ?? card`) is vacuous and passes either way.
Result: 95/96 pass; this is the only failure. I did not touch any test file.

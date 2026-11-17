# T0D-13 dispute — 3 harness defects in the tester files (component code not at fault)
Each was checked by running a temp copy of the test with ONLY the harness line changed (copies deleted): all pass.

1. batch2-dates.test.tsx:20 — whole suite fails to load: "TypeError: The URL must be of scheme file".
   Under jsdom the global URL is jsdom's; on Windows `new URL('../../../../test-fixtures/…', 'file:///C:/…')` resolves to `http://localhost:3000/…`.
   Fix: `import { URL as NodeURL } from 'node:url'` and `readFileSync(new NodeURL(…))` (or fileURLToPath). With that: 119/119 pass.
2. batch2-data.test.tsx:35 (`firstCell`) and :402 (FilterBar multi `pick`) — role given as a RegExp. @testing-library/dom 10.4.2 compares roles with `===`
   (dist/queries/role.js:118-126), so a RegExp never matches (probe: a row with a real role=rowheader + role=gridcell returns 0).
   Breaks 9 DataTable keyboard/selection tests + 1 FilterBar test. Fix: `row.querySelectorAll('[role=gridcell],[role=rowheader]')[i]` /
   `document.querySelectorAll('[role=option],[role=checkbox],[role=menuitemcheckbox]')`. With that: 62/62 pass.
3. batch2-barcode.test.tsx:309 (axe) — times out at 5 s: beforeEach fakes setTimeout for the whole file and axe-core schedules its work with setTimeout.
   Fix: `vi.useRealTimers()` at the start of that test. With that: 46/46 pass.

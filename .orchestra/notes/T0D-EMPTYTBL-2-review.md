APPROVE
Reviewed `git diff dafc0a3f8..HEAD` (T0D-EMPTYTBL-2, LD-336/LD-310). 12 source + 7 test files, under the 24 cap; no route, permission, contract, data, admin/platform change; no PHI/secrets.
- All 11 screens now always draw the header row; empty message in body; 4 aria-hidden placeholder rows via the T0D-EMPTYTBL-1 kit pieces (DataTable `emptyState`, `EmptyRow` + `PlaceholderRows`). No second pattern. Loading/error of WorksheetListPage unchanged.
- colSpans checked against headers: Surcharge/Tax rules/Tax types 6(+1 manage), Mappings 8, Observed 5(+1), Worksheets 3, Molecular COLUMNS+1. Correct.
- Create action repeated in the row only where the header has it and with the same gate (BatchesScreen canWork && !filtered, Tax/Surcharge manage, Mappings inside manage branch). LibraryList starter button has no `isLoading` but `inFlight` ref still blocks double requests; `blocked` is always false when rows are empty.
- Source test: allow list = CollectDispatch only; new test pins the 11 are absent. web-t34 `press` change follows the ruling (same as EMPTYTBL-1 ruling), not a weakening.
- Ran: emptytbl2 config 48/48; emptytbl1.source 6/6. tsc: no errors in touched files (only pre-existing web-t04:127, lab-t26:94 in untouched tests).
Notes (not defects): `packages/ui` EmptyState got an additive `{label, href}` action variant (brief named only DataTable; C0 owns the kit, minimal and typed). InstrumentMappings "Unmapped only" hiding all rows shows headers but no message (pre-existing, unpinned). Lint not run (no eslint binary in apps/web).

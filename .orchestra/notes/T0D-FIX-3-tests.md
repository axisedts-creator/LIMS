# T0D-FIX-3 tests (tester)
Files (apps/web/src/__tests__/): fix3.contract-query.test.ts, fix3.display.test.tsx, vitest.fix3.config.ts.
Run: `.orchestra/notes/T0D-FIX-3-verify.cmd` from repo root (pnpm --dir apps/web exec vitest run --config src/__tests__/vitest.fix3.config.ts).
contract-query: serverFetch stand-in validates query keys against contracts/openapi (listCentres, listCounters, listInventoryCodedSet) = 6a/6b/6c + static source guards. Other web reads NOT contract-checked (gap).
display: 7a Dues page names centres; 7b Reports centre names (writer must map centre_id in reporting listCentres: contract has centre_id, not id); chart colour; undefined rows in SalesTable + Broadcasts; broadcast without audience_filter.party_kinds.
Chart colour pin (no spec exists): a CSS rule for .lims-series-0 or plain .lims-chart-bar sets color/fill to a non-neutral palette value (not currentColor, neutral-8xx/9xx, text tokens). Dispute via ruling path if the palette lives elsewhere.
Not tested: Centre filter option names (Select options render only when open); live deploy; other Sales* components with undefined props.
Before implementation: all tests fail for the intended reasons (stray limit/is_active, no centre names, no series colour, map of undefined).

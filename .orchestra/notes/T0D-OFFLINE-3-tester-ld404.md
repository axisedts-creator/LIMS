LD-404 applied verbatim: rs-c4.signature.ts (route_strings_added regex, 9 itemized REGSCREEN-2 routes + /v1/catalog/${kind}) and rs-c4.static.test.ts (2 asserts after the /v1/frontdesk/patients line). Baseline json untouched.
Run: pnpm --dir apps/web exec vitest run --config src/features/frontdesk/__tests__/vitest.rs-c4.config.ts
Result: Test Files 1 failed | 3 passed (4); Tests 1 failed | 36 passed (37). rs-c4.static now passes.
Only failure: rs-c4.screens.test.tsx:74 Daily cash (open shift) snapshot mismatch (new stat row + chart card from UIDASH-1). Parked per ruling (awaiting founder); not touched, not an OFFLINE-3 defect.
verify.cmd unchanged. Task NOT done while that snapshot is stale.

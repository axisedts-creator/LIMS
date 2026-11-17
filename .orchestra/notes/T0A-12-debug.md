# T0A-12 debugger
- Cause: verify log tail shows only 12 failures, all in packages/shared-ts/test/validation.test.mjs (T0A-08): ERR_MODULE_NOT_FOUND `@lims/contracts` imported from src/errors/index.ts. No T0A-12 test fails in the log tail.
- Not a T0A-12 defect: `@lims/contracts` (contracts/ports/common.ts, C0-0C T0C-02/T0C-05) does not exist/resolve yet; already tracked in .orchestra/cr/T0A-08.md.
- Fix: none. Editing errors/ or workspace links is outside T0A-12 files; tests untouched. T0A-12 suite was 102/102 per impl note. Needs verify scoped to T0A-12 tests, or T0A-08 CR resolved.

## Round 2
- Re-ran T0A-12 scoped suite (formula, spreadsheet, decimal, spreadsheet-guard-ban): 102/102 pass. verify.log failures = 12 T0A-08 validation tests, `@lims/contracts` unresolved (C0-0C, CR T0A-08). No T0A-12 code change; same cause as round 1.
- Needs: verify scoped to T0A-12 tests, or T0A-08 CR resolved. Not fixable inside T0A-12 files.

## Round 3
- Re-ran T0A-12 scoped suite: 102/102 pass. verify.log failures still the 12 T0A-08 validation tests (`@lims/contracts` unresolved, CR T0A-08). No code change; not fixable in T0A-12 files.
- Needs: verify scoped to T0A-12 tests (see T0A-12-verify.cmd), or T0A-08 CR resolved by C0-0C.

## Round 4
- New failure (not the T0A-08 one): decimal.test.mjs:23 exact-pin test rejects `@lims/contracts: workspace:*` in shared-ts/package.json (T0A-08-owned, not a T0A-12 file).
- Test contradicts spec: workspace link is not a version range; exact-pin rule (02-CONVENTIONS.md:13) covers external versions. No impl change. Wrote .orchestra/notes/T0A-12-dispute.md; stopped.

## Round 5
- Same failure as round 4: decimal.test.mjs:23 rejects `@lims/contracts: workspace:*` (T0A-08-owned package.json). Dispute already in T0A-12-dispute.md, no ruling yet for it (T0A-12-ruling.md covers the older `__PROTO__` dispute). No impl change; stopped.

## Round 6
- Same failure: decimal.test.mjs:23 rejects `@lims/contracts: workspace:*` (T0A-08-owned package.json). No new ruling on T0A-12-dispute.md (ruling.md is the older `__PROTO__` one).
- No impl change, tests untouched. Needs a ruling: tester skips `workspace:` values in the exact-pin loop (see dispute.md).

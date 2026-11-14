LEAD RULING LD-171

Verdict: TESTS_WRONG (timing only). The implementation is correct (SettingsForm.tsx:71, :157-158). The rule stays: spec/chunks/C17-home-collection/02-TRD.md:549 (payment_methods 1..10, codes from the C4 seed set, D-128) and :195 (H19 400 common.validation_failed).

TESTER (apps/web/src/features/homecollection/__tests__/hc-t20.settings.test.tsx):
1. After line 248 (picking the 'Cash' option), add: `await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 10000 });` and `await waitFor(() => expect(within(rows()[2]!).getByRole('button', { name: /code|method/i }).textContent).toMatch(/cash/i), { timeout: 10000 });`. Submit only after these pass.
2. Line 250: pass `{ timeout: 10000 }` to the `waitFor`. Keep the regex `/once|duplicate|already|unique/i` and line 251 `expect(puts()).toHaveLength(0)` exactly as they are.
3. Line 180 (range test): pass `{ timeout: 10000 }` to its `waitFor`. Instead of items 2 and 3 you may set `configure({ asyncUtilTimeout: 10000 })` once in the HC-T20 vitest setup.
4. Do not delete, skip or loosen any assertion.
5. Re-run HC-T20-verify.cmd (`--maxWorkers=1 --testTimeout=60000 --hookTimeout=120000 --teardownTimeout=120000`). It must show 5/5 files and 148/148 tests.

WRITER:
6. No implementation change. Only if the verify run shows a real failure in the implementation, fix that failure and cite it.

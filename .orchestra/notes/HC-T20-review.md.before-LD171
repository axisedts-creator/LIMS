CHANGES

Reviewer: HC-T20 round 3, diff b8537aac..d0c5fb78. Round-2 item 1 is fixed: `tests/homecollection/tmpfix.sh` is deleted. Round-2 item 2 is applied as written (`settle()` replaced by `waitFor` at settings.test:180 and :250), but it does not fix the failure.
Checks run: HC-T20-verify.cmd (full config, `--maxWorkers=1 --testTimeout=60000 --hookTimeout=120000 --teardownTimeout=120000`). Result: 147/148 pass, 1 fail. The failing test is the same one as before.

1. `apps/web/src/features/homecollection/__tests__/hc-t20.settings.test.tsx:245-252` ("the same code twice -> no PUT and a message") still fails in the full serial run: `expected 'Home Collection settings…' to match /once|duplicate|already|unique/i`. The DOM shows the two Cash rows and zero PUTs. The impl is correct (SettingsForm.tsx:71, :158), and the test passes when run alone (HC-T20-debug.md round 2), so this is a test-timing defect. The default `waitFor` timeout is 1000 ms. Under load, the React Aria popover also restores focus to the Select trigger after `from.focus()`, so the Ctrl+Enter may never reach the form. Fix (tester):
   - After line 248, wait for the popover to close and for the change to land: `await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 10000 }); await waitFor(() => expect(within(rows()[2]!).getByRole('button', { name: /code|method/i }).textContent).toMatch(/cash/i), { timeout: 10000 });`
   - Line 250: pass `{ timeout: 10000 }` to the `waitFor`.
   - Line 180 (range test): give its `waitFor` the same `{ timeout: 10000 }`. An alternative that covers both is `configure({ asyncUtilTimeout: 10000 })` in the HC-T20 vitest setup.
   - Re-run HC-T20-verify.cmd, which must show 148/148.

Checked OK (unchanged since round 2): verbatim names/routes/permissions/error codes, Idempotency-Key + If-Match on H15/H17 and If-Match on H19, permission gate before any fetch, D-125/D-128/D-129, LD-140, membership_id wipe link, H15 items 1..50, no PHI or secrets, owned paths only, RLS n/a (web only). The round 3 diff has no impl changes.

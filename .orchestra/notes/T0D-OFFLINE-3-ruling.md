TESTS_WRONG — rs-c4.screens.test.tsx:74 "Daily cash (open shift)" snapshot pins pre-UIDASH-1 markup; no spec line ties the Daily cash screen to OFFLINE-3. Apply lead ruling LD-409 (bottom of this file): re-record that one snapshot.
Reasons (arbiter, 2026-11-19, dispute round 15):
1. rs-c4 snapshots are RS-task visual records (spec/program/10-DESIGN-SYSTEM.md:135,137); a later landed feature (T0D-UIDASH-1, LD-353 rule 10/template 5) legitimately changed the screen. Diff is additive (stat row + chart card before "My shift").
2. OFFLINE-3 done_when (1)-(6) cover registration, billing receipts, collection/accession; none touches Daily cash. Lane diff has no Daily cash source change.
3. LD-409 (lead, binding in this lane) lifts the earlier "parked" note: regenerate ONLY this snapshot.
TESTER (rs-c4.screens.test.tsx.snap only, via the runner, never hand-edit): `pnpm --dir apps/web exec vitest run --config src/features/frontdesk/__tests__/vitest.rs-c4.config.ts -u -t "Daily cash \(open shift\)" src/features/frontdesk/__tests__/rs-c4.screens.test.tsx`. Confirm git diff changes only "Daily cash (open shift) 1" (Register x3, Credit party untouched). Commit the .snap itself, not only notes; paste the run result in the tester note.
Flag (not blocking, per LD-409): new markup drops Business date aria-describedby + hint; owner of Daily cash screen to restore.
WRITER and DEBUGGER: no code change. Next same-family gap: escalate lane-isolation question (LD-404/LD-409), do not patch.

---- prior arbiter ruling (superseded by the above) ----

TESTS_WRONG — rs-c4.static.test.ts:79 rejects 9 frontdesk_feature route strings that are already-landed T0D-REGSCREEN-2 work; no spec line ties them to OFFLINE-3. Apply lead item LD-404 (bottom of this file) verbatim.
Reasons (arbiter, 2026-11-19, dispute after tester 62ed67017):
1. LD-140 guard binds restyle tasks only (spec/program/10-DESIGN-SYSTEM.md:132-136); the 9 strings live in frontdesk/server/read.server.ts:56-61,77 and write.server.ts:94-98 (grep), REGSCREEN-2 drafts/custom fields/favourites/ICD/number preview, not OFFLINE-3 code.
2. LD-404 (lead, binding in this lane) is the itemized, anchored regex for exactly these 9; its EDIT 1 "find" text matches rs-c4.signature.ts:116 and EDIT 2 "find" text matches rs-c4.static.test.ts:93 exactly (checked). No correction needed this time.
TESTER (rs-c4.signature.ts and rs-c4.static.test.ts only; never edit rs-c4.baseline.json): apply LD-404 EDITS 1-2 verbatim. Commit the two test files themselves, not only notes; run vitest.rs-c4.config.ts and paste the result in the tester note.
Daily cash (open shift) snapshot: still parked per lead (awaiting founder); task is NOT done while it is stale. Not an OFFLINE-3 implementation defect.
WRITER and DEBUGGER: no code change. Lane-isolation question in LD-404 NOTE TO FOUNDER is outside arbiter scope.

---- prior arbiter ruling (superseded by the above) ----

TESTS_WRONG — rs-c4.static.test.ts:74-75 rejects 32 frontdesk_feature server_symbols that are already-landed T0D-REGSCREEN-2 work; no spec line ties them to OFFLINE-3. Apply lead item LD-403 (bottom of this file) with ONE correction.
Reasons (arbiter, 2026-11-19 03:30, dispute round 14 of verify 03:03):
1. LD-140 guard binds restyle tasks only (spec/program/10-DESIGN-SYSTEM.md:132-136); lane diff has no OFFLINE-3 source in frontdesk/server.
2. All 32 names are absent from baseline frontdesk_feature.server_symbols (rs-c4.baseline.json:123-200; the hits for ReceiptDocument/getPatient/listCatalogOptions at :289/:347/:349 are other areas) and are exported from frontdesk/server/*.ts (grep). Writer note (commit e0e76438d) also counts +32.
3. LD-403 (lead, below) is the lead's pattern decision after LD-400's "escalate instead"; arbiter follows it. Its list has 32 names but its EDIT 3 says toHaveLength(31): counting error.
TESTER (rs-c4.signature.ts and rs-c4.static.test.ts only; never edit rs-c4.baseline.json): apply LD-403 EDITS 1-3 verbatim EXCEPT write `expect(LD310_ALLOW.regscreen2_symbols).toHaveLength(32); // LD-403`. Commit the two test files themselves, not only notes; run vitest.rs-c4.config.ts and paste the result in the tester note.
Daily cash (open shift) snapshot: stays parked per the lead NOTE below (escalated to founder); task is NOT done while it is stale. Not an OFFLINE-3 implementation defect.
WRITER and DEBUGGER: no code change. Could not run vitest here (permission denied); facts from dispute, writer note, grep.

---- prior arbiter ruling (superseded by the above) ----

TESTS_WRONG — rs-c4 still asserts the already-landed REGSCREEN-2/accounting/UIDASH-1 drift is absent; binding LD-400 (task brief) ruled it allowed and fixed the pattern, but its edits are not in C0-0K, so the tester must apply them.
Reasons (arbiter, 2026-11-19 02:50, dispute round 13 of verify 02:42):
1. Prior CR_NEEDED (below) waited on a lead pattern decision per LD-398; LD-400 (brief; lead decisions in the brief override spec text) is that decision: route_strings_added becomes a scoped regex. CR resolved; no CR file needed.
2. LD-400 claims direct edits, but C0-0K has rs-c4.signature.ts:113 `route_strings_added: ['/v1/catalog/tests']`, rs-c4.static.test.ts:78 `.includes(r)`, :90 `toHaveLength(1)`, and no `frontdesk.patient.read` in LD310_ALLOW.permissions (grep). LD-401 corrects LD-400 that its edits did not land in this lane.
3. Drift source unchanged: LD-140 guard binds restyle tasks only (spec/program/10-DESIGN-SYSTEM.md:132-136); frontdesk.patient.read is REGSCREEN-2 (RegistrationForm.tsx:259); no OFFLINE-3 source causes any failure. Not IMPLEMENTATION_WRONG.
TESTER (rs-c4.signature.ts, rs-c4.static.test.ts, rs-c4.screens snapshot only; comment "LD-400, T0D-OFFLINE-3 arbiter"; never edit rs-c4.baseline.json):
1. signature.ts: add 'frontdesk.patient.read' to LD310_ALLOW.permissions.
2. signature.ts:113: replace the list with a regex, e.g. `route_strings_added: /^\/v1\/billing\/|^\/v1\/identity\/(centres|users)$|^\/billing\/accounts\/ledger$|^\/v1\/catalog\/tests$/,` (adjust only so it matches exactly the 22 strings in the verify 02:42 log; must still match '/v1/catalog/tests').
3. static.test.ts:78: `.filter((r) => !LD310_ALLOW.route_strings_added.test(r))`.
4. static.test.ts:90: replace toHaveLength(1) with `expect(LD310_ALLOW.route_strings_added.test('/v1/billing/accounts/summary')).toBe(true)` and `expect(LD310_ALLOW.route_strings_added.test('/v1/frontdesk/patients')).toBe(false)`.
5. Re-record ONLY "Daily cash (open shift)" with the runner: `vitest -u -t "Daily cash \(open shift\)"` on rs-c4.screens.test.tsx; never hand-edit the .snap; confirm git diff shows that .snap changed and no other snapshot did. Commit the test files themselves (earlier rounds committed only notes).
WRITER and DEBUGGER: no code change. Per LD-400, if rs-c4 trips again in any category, escalate to the lead (founder structural call); no further allow-list patch.

---- prior arbiter ruling (superseded by the above) ----

CR_NEEDED — the spec has no rule for how the frozen rs-c4 restyle baseline treats approved feature work merged from main, and binding LD-398 forbids a 5th allow-list patch without a lead pattern decision; CR text in .orchestra/cr/T0D-OFFLINE-3.md.
Reasons (arbiter, 2026-11-19 01:50, dispute of verify 01:49):
1. LD-140 guard scope is restyle tasks only (spec/program/10-DESIGN-SYSTEM.md:132-136); it says nothing about later feature drift or re-pinning rs-c4.baseline.json. That rule is missing.
2. Lane diff `git diff main...HEAD -- apps/web` = 4 test files, 0 source files: no OFFLINE-3 implementation causes any failure, so it is not IMPLEMENTATION_WRONG.
3. Item 1 confirmed: `frontdesk.patient.read` came from T0D-REGSCREEN-2 (commit 35ca99fa4; RegistrationForm.tsx:259, server/read.server.ts:55), already on main.
4. Items 2-3 (22 billing_feature route strings, Daily cash snapshot) are the same accounting/UIDASH-1 drift as LD-391/LD-393/LD-398.
5. LD-398 (task brief, binding over spec): "if this same guard blocks again ... the pattern itself, not just the list, needs a decision from me before a 5th round". So the arbiter may not order another TESTS_WRONG widening.
6. CR proposes A (re-pin baseline at a recorded main SHA by lead LD, then delete feature-drift allow entries) or B (guard gates restyle tasks only). Recommended: A.
WRITER, TESTER, DEBUGGER: no change until the lead records a decision. Could not re-run vitest here (permission denied); facts taken from the dispute plus git/grep checks.

---- prior arbiter ruling (superseded by the line above) ----

TESTS_WRONG — the rs-c4 guard asserts that already-landed, already-ruled feature work (T0B-ACCT-1/T0B-FINCTRL-1 accounting, T0D-REGSCREEN-2 drafts, T0D-UIDASH-1 stat row + chart) never happened; no spec line requires T0D-OFFLINE-3 to undo it.
Reasons (arbiter, 2026-11-19, after re-running vitest.rs-c4.config.ts: exactly the 6 failures listed in T0D-OFFLINE-3-dispute.md, nothing else):
1. rs-c4 enforces LD-140 "restyle = behaviour unchanged" (spec/program/10-DESIGN-SYSTEM.md:132-136); it binds restyle tasks, not later approved feature tasks. `git diff main...HEAD -- apps/web` shows OFFLINE-3 lane changes only the two rs-c4 tester files; none of the 6 drifts is OFFLINE-3 code.
2. LD-391/LD-393 (task brief) already ruled the billing accounting drift allowed via LD310_ALLOW, but under-scoped it; items 1-4 below are the rest of that same drift.
3. LD-353 (task brief) names T0D-REGSCREEN-2 and T0D-UIDASH-1 as approved UI work: RegistrationForm.tsx:891-892 "Save as draft"/"Drafts" (ghost, not primary) and the REPORT-template stat row + chart (LD-353 rule 10, template 5) are approved behaviour, so test 5 and snapshot 6 are stale.
4. rs-c4.baseline.json stays untouched (its own header comment); fix by extending LD310_ALLOW, same mechanism as LD-391/LD-393.

TESTER (files rs-c4.signature.ts, rs-c4.static.test.ts, rs-c4.register.test.tsx, and the rs-c4.screens snapshot file only; comment each change "LD-391/LD-393 follow-up, T0D-OFFLINE-3 arbiter"):
1. signature.ts LD310_ALLOW: add `logic_files_added` = exactly ['src/features/billing/server/accounts.actions.ts','src/features/billing/server/accounts.server.ts','src/features/billing/server/expenses.actions.ts','src/features/billing/server/expenses.server.ts']. static.test "same bytes": compare keys of `now` minus entries that are in logic_files_added AND not in baseline.logic; separately assert every baseline.logic key still exists.
2. Add `route_strings_added` = exactly ['/v1/catalog/tests']; change `expect(added(was.routes, now.routes)).toEqual([])` to filter out route_strings_added.
3. Add to LD310_ALLOW.server_imports exactly: 'server/accounts.actions','server/accounts.server','server/expenses.actions','server/expenses.server'.
4. Add `accounts_symbols` = exactly the 19 names in dispute item 4 (PARTY_KINDS PartyKind TRANSFER_TABS TransferTab UUID_RE cleanFilters dateRange expenseFilters getAccountStatement getDailyCollectionSummary listAccountGroups listAccountLedgerEntries listAccountParticulars listAccountParties listAccountSummaryRows listCashTransfers listExpenseTypes listExpenses listMembers); exclude them when computing extraSymbols (before the trf_symbol and length<=1 checks).
5. Not-vacuous test: add expect lengths logic_files_added 4, route_strings_added 1, accounts_symbols 19; expect(LD310_ALLOW.accounts_symbols).not.toContain('deleteEverythingAction').
6. rs-c4.register.test.tsx:122: replace the no-draft assertion with: buttons named exactly "Save as draft" and "Drafts" exist and neither has class lims-btn-primary (primary stays only "Register & print").
7. Re-record ONLY the "Daily cash (open shift)" snapshot (`vitest -u -t "Daily cash \(open shift\)"`); confirm no other snapshot changed in the diff.
WRITER and DEBUGGER: no code change. If rs-c4 fails again on new strings, escalate to the lead per LD-393; do not re-verify.

---- prior lead items (unchanged) ----

## LEAD ITEM LD-391 FOR THE TESTER (written by the lead, 20:55 NPT; this is a test file item and it is yours)
Files: src/features/frontdesk/__tests__/rs-c4.signature.ts and src/features/frontdesk/__tests__/rs-c4.static.test.ts. Change only these two files. Never edit rs-c4.baseline.json.
Why: the rs-c4 restyle guard (LD-140/LD-310) compares the live tree to the frozen baseline. OFFLINE-3 itself only touches outbox.ts and engine.ts (one WIRE_KEYS entry, one optional field); it adds no route and no permission. The 2 failures are both already-landed, already-ruled billing accounting UI (the T0B-ACCT-1/T0B-FINCTRL-1 area) that this lane pulled in from main at task start, not an OFFLINE-3 regression:
  (a) billing_app area: 7 new permission codes not yet in LD310_ALLOW.permissions: billing.account.manage, billing.account.read, billing.accounts.col.blocked, billing.accounts.col.credit_limit, billing.accounts.col.outstanding, billing.accounts.col.side, billing.accounts.summary.title.
  (b) whole app route tree hard pin (routeFiles() vs baseline.route_files, no allow-list exists for this check yet): 8 new files, all additions, no removal: src/app/(staff)/billing/accounts/entries/page.tsx, billing/accounts/ledger/page.tsx, billing/accounts/masters/page.tsx, billing/accounts/pocket/page.tsx, billing/accounts/summary/page.tsx, billing/cash-transfers/page.tsx, billing/expenses/page.tsx, billing/expenses/types/page.tsx.
1. In rs-c4.signature.ts add a new readonly array routes_added to LD310_ALLOW containing exactly the 8 paths listed above, no others.
2. Add the 7 permission codes listed above to LD310_ALLOW.permissions in rs-c4.signature.ts, no others.
3. In rs-c4.static.test.ts change the route tree assertion (expect(routeFiles()).toEqual(baseline.route_files)) to: first remove from routeFiles() any path that is in LD310_ALLOW.routes_added and is not already in baseline.route_files, assert that filtered list equals baseline.route_files, and separately assert every path in baseline.route_files is still present in routeFiles() (a real removal of an existing route must still fail the test).
4. Add one assertion to the existing allow-list-is-not-vacuous test checking LD310_ALLOW.routes_added has length 8, mirroring the existing logic_files length check.
5. Touch no other file. Do not regenerate rs-c4.baseline.json. Writer and debugger: no code change; outbox.ts and engine.ts are correct as is.


## LEAD ITEM LD-393 FOR THE TESTER (written by the lead, 21:40 NPT; this is a test file item and it is yours; supersedes nothing in LD-391, only adds to it)
Files: src/features/frontdesk/__tests__/rs-c4.signature.ts and src/features/frontdesk/__tests__/rs-c4.static.test.ts. Change only these two files. Never edit rs-c4.baseline.json.
Why: LD-391 only named 7 permission codes, but the already-landed billing accounting UI (T0B-ACCT-1/T0B-FINCTRL-1 area) actually added 152 billing.* strings in total (almost all i18n/column-label keys picked up by the same extractor as real permission codes) plus 2 server_imports. Verified: every one of the 152 added strings matches the single pattern below, checked against the full added-list from the verify log, zero misses. OFFLINE-3 itself adds no permission, route or server_import.
1. In rs-c4.signature.ts, add to LD310_ALLOW a new entry:
   billing_accounts_strings: /^billing\.(account_entry|cash_transfer|expense)\.|^billing\.accounts\.(col|entries|error|field|filter|ledger|masters|pocket|reason|receipt|summary)\./,
   with a one-line comment that it covers the T0B-ACCT-1/T0B-FINCTRL-1 accounting UI i18n and column-label keys landed on main, not a general escape hatch.
2. In the same LD310_ALLOW object, add to server_imports (literal strings, no others):
   '@/features/billing/server/accounts.server',
   '@/features/billing/server/expenses.server',
3. In rs-c4.static.test.ts, change the line:
   expect(added(was.permissions, now.permissions).filter((p) => !(LD310_ALLOW.permissions as readonly string[]).includes(p))).toEqual([]);
   to also exclude anything the new regex matches, e.g.:
   expect(added(was.permissions, now.permissions).filter((p) => !(LD310_ALLOW.permissions as readonly string[]).includes(p) && !LD310_ALLOW.billing_accounts_strings.test(p))).toEqual([]);
   (same style already used for trf_symbol filtering server_symbols a few lines below).
4. In the "allow-list guard is not vacuous" test, add one line: expect(LD310_ALLOW.billing_accounts_strings.test('frontdesk.order.cancel')).toBe(false);
5. Touch no other file. Writer and debugger: no code change needed; outbox.ts and engine.ts remain correct as is.

## LEAD ITEM LD-398 FOR THE TESTER (written by the lead, 2026-11-19 01:05 NPT)

Round 11 of the same rs-c4 guard saga. Pulled the exact current failing diff from the latest verify log myself (not hand-sampled). Three gaps in `rs-c4.signature.ts` / `rs-c4.static.test.ts`, plus one snapshot. Nothing removed from the baseline json; it stays untouched.

### 1. Six more files allowed to change bytes (NOT the `logic_files` list — that stays exactly 4, frontdesk-only)

In `rs-c4.signature.ts`, add a new category to `LD310_ALLOW` (do not touch the existing `logic_files` array or its `toHaveLength(4)` check):
```
  // LD-398 (T0D-OFFLINE-3): already-landed REGSCREEN-2 drafts feature + billing accounting module; bytes may change, same as logic_files.
  logic_files_changed: [
    'src/features/billing/nav.manifest.ts',
    'src/features/billing/server/actions.ts',
    'src/features/billing/server/types.ts',
    'src/features/billing/server/write.server.ts',
    'src/features/frontdesk/forms/draft.ts',
    'src/features/frontdesk/hooks/useShortcuts.ts',
  ],
```
In `rs-c4.static.test.ts`, the "same bytes" test's `changed` line currently reads:
```
    const changed = Object.keys(baseline.logic).filter((k) => now[k] !== baseline.logic[k] && !(LD310_ALLOW.logic_files as readonly string[]).includes(k));
```
Change it to also exclude the new category:
```
    const changed = Object.keys(baseline.logic).filter((k) => now[k] !== baseline.logic[k] && !(LD310_ALLOW.logic_files as readonly string[]).includes(k) && !(LD310_ALLOW.logic_files_changed as readonly string[]).includes(k));
```

### 2. One route string frontdesk_feature legitimately no longer references directly

This is a REMOVAL, which no allow-list category currently covers (removals are supposed to be real losses) — except this one is not a real loss: `/v1/catalog/tests` only still appears in `frontdesk/__tests__/fd-t13.harness.tsx` (a mock, outside the scan path), because the real call moved into `billing_feature` code, where `route_strings_added` already forgives it as an addition. Same shape as the existing `CRUMB_ONLY` exception for billing_feature's own `/billing/credit-parties` (T0D-UNSLOP-1 ruling).

In `rs-c4.static.test.ts`, the `CRUMB_ONLY` line currently reads:
```
    const CRUMB_ONLY: Partial<Record<Area, string[]>> = { billing_feature: ['/billing/credit-parties'] };
```
Change it to:
```
    const CRUMB_ONLY: Partial<Record<Area, string[]>> = { billing_feature: ['/billing/credit-parties'], frontdesk_feature: ['/v1/catalog/tests'] };
```
Add a one-line comment above it citing LD-398: the route moved into billing_feature's own code (already an allowed addition there); only a test-harness mock in frontdesk still mentions the string, which this guard does not scan.

### 3. 45 more billing_feature server symbols (accounting types + action functions)

Extend the EXISTING `accounts_symbols` array in `rs-c4.signature.ts` (same category, same reasoning — do not create a second list) with these 45 names, verified against the exact failing list with zero misses and checked for anything destructive-sounding (none found):
```
'AccountGroup', 'AccountLedgerEntry', 'AccountParticular', 'AccountParty', 'AccountStatement', 'AccountStatementRow',
'AccountSummary', 'CashTransfer', 'CreateEntryInput', 'CreateExpenseInput', 'CreateTransferInput', 'DailyCollectionSummary',
'EntryType', 'Expense', 'ExpenseType', 'GroupNature', 'Named', 'PRINT_STYLES', 'PocketBalance', 'PrintStyle', 'STYLE_LABEL',
'TransferKind', 'cancelExpense', 'cancelExpenseAction', 'createAccountEntryAction', 'createAccountGroup', 'createAccountGroupAction',
'createAccountLedgerEntry', 'createAccountParticular', 'createAccountParticularAction', 'createCashTransfer', 'createCashTransferAction',
'createExpense', 'createExpenseAction', 'createExpenseType', 'decideCashTransfer', 'decideCashTransferAction', 'getPocketBalance',
'getPocketBalanceAction', 'reverseAccountEntryAction', 'reverseAccountLedgerEntry', 'saveExpenseTypeAction', 'updateAccountMaster',
'updateAccountMasterAction', 'updateExpenseType'
```
The array will then hold 19 (existing) + 45 (new) = 64 entries total, keep it alphabetically/logically grouped however you like, duplicates are harmless but avoid them if easy.

### 4. Update the "allow-list guard is not vacuous" test to match

In `rs-c4.static.test.ts`:
- Change `expect(LD310_ALLOW.accounts_symbols).toHaveLength(19);` to `expect(LD310_ALLOW.accounts_symbols).toHaveLength(64);`
- Add `expect(LD310_ALLOW.logic_files_changed).toHaveLength(6);`
- Leave every other assertion in that test (`logic_files` length 4, `routes_added` length 8, `route_strings_added` length 1, the `not.toContain`/`.test(...)` sanity checks) exactly as they are.

### 5. Re-record ONE snapshot: "Daily cash (open shift)"

`rs-c4.screens.test.tsx` snapshot `RS-C6 key-screen snapshots > Daily cash (open shift) 1` (file: `__snapshots__/rs-c4.screens.test.tsx.snap`) is stale: the live render now includes a stat row (Gross/Reversed/Net/Variance) and a "Net by payment method" chart card, from the already-landed UIDASH-1 work, before the "My shift" section. This is a large, nested HTML change — do NOT hand-edit the `.snap` file. Run your project's normal vitest update-snapshot step against this one test file only (e.g. `vitest run src/features/frontdesk/__tests__/rs-c4.screens.test.tsx -u` from `apps/web`, or your established equivalent), so it captures the current passing render exactly. Touch no other snapshot in this file.

Do not touch `rs-c4.baseline.json`. Do not touch any source file (billing or frontdesk) to make any of this pass.

WRITER and DEBUGGER: no code change. If this same guard blocks again after this round with yet more drift, stop and escalate to the lead by name rather than running more rounds — the allow-list-widening approach itself needs a decision at that point, not another patch.


================================================================================
LEAD ITEM LD-401 FOR THE WRITER (TESTS_WRONG, two allow-list additions in rs-c4.signature.ts
and rs-c4.static.test.ts; plain source edits, NOT the snapshot file -- that is a separate,
already-escalated item, see below)

Make exactly these two edits. Both are additive allow-list changes; nothing is deleted from
either file except the two literal text spans named below, which are replaced in place.

EDIT 1 of rs-c4.signature.ts -- find this exact block (inside LD310_ALLOW):

  permissions: [
    'catalog.price_list.manage', 'catalog.referrer.manage', 'catalog.code_duplicate',
    'billing.account.manage', 'billing.account.read', 'billing.accounts.col.blocked', 'billing.accounts.col.credit_limit',
    'billing.accounts.col.outstanding', 'billing.accounts.col.side', 'billing.accounts.summary.title',
  ],

Replace it with:

  permissions: [
    'catalog.price_list.manage', 'catalog.referrer.manage', 'catalog.code_duplicate',
    'billing.account.manage', 'billing.account.read', 'billing.accounts.col.blocked', 'billing.accounts.col.credit_limit',
    'billing.accounts.col.outstanding', 'billing.accounts.col.side', 'billing.accounts.summary.title',
    // LD-401 (T0D-OFFLINE-3): already-landed T0D-REGSCREEN-2/T0B-REGAPI-1/2 patient-rewards permission (RegistrationForm.tsx:259); not this task's own change.
    'frontdesk.patient.read',
  ],

EDIT 2 of rs-c4.signature.ts -- find this exact block (also inside LD310_ALLOW):

  // LD-391/LD-393 follow-up, T0D-OFFLINE-3 arbiter: the one route string added by the already-landed work.
  route_strings_added: ['/v1/catalog/tests'],

Replace it with:

  // LD-401 (T0D-OFFLINE-3): converted from an itemized list to a scoped regular expression, the same
  // device already used by billing_accounts_strings below. Forgives the v1/billing path prefix, the
  // v1/identity/centres and v1/identity/users routes, the billing/accounts/ledger page link, and the
  // one entry that was already here.
  route_strings_added: /^\/v1\/catalog\/tests$|^\/v1\/billing\/|^\/v1\/identity\/(?:centres|users)\b|^\/billing\/accounts\/ledger\b/,

EDIT 3 of rs-c4.static.test.ts -- find this exact line:

    expect(added(was.routes, now.routes).filter((r) => !(LD310_ALLOW.route_strings_added as readonly string[]).includes(r))).toEqual([]); // no route added: POST credit-parties / doctors / trf-attachments already exist

Replace it with:

    expect(added(was.routes, now.routes).filter((r) => !LD310_ALLOW.route_strings_added.test(r))).toEqual([]); // LD-401: route_strings_added is now a scoped regex, not a list

EDIT 4 of rs-c4.static.test.ts -- find this exact line:

    expect(LD310_ALLOW.route_strings_added).toHaveLength(1);

Replace it with:

    expect(LD310_ALLOW.route_strings_added.test('/v1/billing/some-new-endpoint')).toBe(true); // LD-401: the billing accounting module's own namespace is forgiven...
    expect(LD310_ALLOW.route_strings_added.test('/v1/frontdesk/patients')).toBe(false); // ...but an unrelated route is still caught

That is the whole fix for this LEAD ITEM. Do not touch anything else in either file. Do not touch
the Daily cash snapshot in this round -- see the separate note below.

----
NOTE ON THE DAILY CASH SNAPSHOT (rs-c4.screens.test.tsx.snap, "Daily cash (open shift) 1"):
the lead attempted a direct edit of this file from outside the normal writer/tester flow this
round and confirmed, via the next verify run, that the edit did not survive -- something in this
lane's own flow between the edit and the verify discarded the uncommitted change. This is now a
confirmed, reproducible failure of BOTH the LEAD ITEM instruction channel (3+ rounds, LD-398) and
a direct edit (this round). The lead is not attempting a third approach and is escalating this
specific snapshot to the founder as a tooling/process question rather than ruling on it again.
WRITER and DEBUGGER: leave this one snapshot alone until you hear otherwise; do not attempt the
vitest update-snapshot flag again on it this round, and do not mark the task done with it still
stale. Everything else in this LEAD ITEM (the four edits above) is normal, ruled work -- apply and
commit those as usual.

----
LEAD ITEM, LD-403 (T0D-OFFLINE-3): new rs-c4 server_symbols gap -- 31 already-landed T0D-REGSCREEN-2
drafts/custom-fields/favourites/ICD-lookup symbols (CustomFieldDefinition, DraftRecordSummary, IcdCode,
NumberPreview, OrderFields, ReceiptDocument, addFavouriteAction, addFavouriteTest, createDraftAction,
createRegistrationDraft, deleteDraftAction, deleteRegistrationDraft, getDraftAction, getPatient,
getPatientRewards, getPatientRewardsAction, getPatientSummaryAction, getRegistrationDraft,
listCatalogOptions, listCustomFieldDefinitions, listCustomFieldDefinitionsAction, listDraftsAction,
listFavouriteTests, listFavouritesAction, listIcdCodes, listIcdCodesAction, listRegistrationDrafts,
listTestNamesAction, previewNumbersAction, previewRegistrationNumbers, removeFavouriteAction,
removeFavouriteTest), all exported from the 3 already-allowed logic_files (server/actions.ts,
server/read.server.ts, server/types.ts) -- same pattern as LD-391/393/398/400/401. None destructive:
all read/list/create-draft/delete-draft/favourite-toggle/preview actions and type names; no account,
party or ledger symbol among them, and none match the trf_symbol pattern either.

EDIT 1 of rs-c4.signature.ts -- inside LD310_ALLOW, find this exact line:

  server_symbols: ['createCreditPartyAction', 'createDoctorAction'],

Replace it with:

  // LD-403 (T0D-OFFLINE-3): already-landed T0D-REGSCREEN-2 drafts/custom-fields/favourites/ICD-lookup
  // symbols (server/actions.ts, server/read.server.ts, server/types.ts); excluded before the
  // trf_symbol check, same device as accounts_symbols.
  regscreen2_symbols: [
    'CustomFieldDefinition', 'DraftRecordSummary', 'IcdCode', 'NumberPreview', 'OrderFields', 'ReceiptDocument',
    'addFavouriteAction', 'addFavouriteTest', 'createDraftAction', 'createRegistrationDraft', 'deleteDraftAction',
    'deleteRegistrationDraft', 'getDraftAction', 'getPatient', 'getPatientRewards', 'getPatientRewardsAction',
    'getPatientSummaryAction', 'getRegistrationDraft', 'listCatalogOptions', 'listCustomFieldDefinitions',
    'listCustomFieldDefinitionsAction', 'listDraftsAction', 'listFavouriteTests', 'listFavouritesAction',
    'listIcdCodes', 'listIcdCodesAction', 'listRegistrationDrafts', 'listTestNamesAction', 'previewNumbersAction',
    'previewRegistrationNumbers', 'removeFavouriteAction', 'removeFavouriteTest',
  ],
  server_symbols: ['createCreditPartyAction', 'createDoctorAction'],

EDIT 2 of rs-c4.static.test.ts -- find this exact line:

    const extraSymbols = added(was.server_symbols, now.server_symbols).filter((s) => !(LD310_ALLOW.server_symbols as readonly string[]).includes(s) && !(LD310_ALLOW.accounts_symbols as readonly string[]).includes(s));

Replace it with:

    // LD-403, T0D-OFFLINE-3: regscreen2_symbols excluded the same way accounts_symbols already is
    const extraSymbols = added(was.server_symbols, now.server_symbols).filter((s) => !(LD310_ALLOW.server_symbols as readonly string[]).includes(s) && !(LD310_ALLOW.accounts_symbols as readonly string[]).includes(s) && !(LD310_ALLOW.regscreen2_symbols as readonly string[]).includes(s));

EDIT 3 of rs-c4.static.test.ts -- find this exact line:

    expect(LD310_ALLOW.accounts_symbols).not.toContain('deleteEverythingAction');

Replace it with:

    expect(LD310_ALLOW.accounts_symbols).not.toContain('deleteEverythingAction');
    expect(LD310_ALLOW.regscreen2_symbols).toHaveLength(31); // LD-403
    expect(LD310_ALLOW.regscreen2_symbols).not.toContain('deleteEverythingAction');

That is the whole fix for this LEAD ITEM. Do not touch anything else in either file. Do not touch
the Daily cash snapshot in this round -- still parked per the note above, awaiting the founder's
answer on the snapshot-editing tooling gap.

----
LEAD ITEM, LD-404 (T0D-OFFLINE-3): rs-c4.static.test.ts:79 route_strings_added gap -- 9 more
already-landed T0D-REGSCREEN-2 route strings (drafts/custom-fields/favourites/ICD/number-preview,
same module as LD-403's regscreen2_symbols), confirmed by direct source grep of
frontdesk/server/read.server.ts and write.server.ts (not in the OFFLINE-3 diff): the exact strings
the ROUTE scanner captures are /v1/frontdesk/custom-field-definitions, /v1/frontdesk/favourite-tests,
/v1/frontdesk/favourite-tests/${uuid (truncates at the open paren of uuid(orderableId) inside the
template literal -- this is correct scanner behaviour, not a bug), /v1/frontdesk/icd-codes,
/v1/frontdesk/registration-drafts, /v1/frontdesk/registration-drafts/${id,
/v1/frontdesk/registration-drafts/${uuid, /v1/frontdesk/registrations/number-preview, and
/v1/catalog/${kind} (this one keeps its closing brace because kind has no parens inside the
template expression). Verified the extended regex below against all 9 plus the existing allow-list
entries as true, and against /v1/frontdesk/patients and 7 other near-miss negative controls as
false, with a standalone regex test before writing this.

EDIT 1 of rs-c4.signature.ts -- find this exact line:

  route_strings_added: /^\/v1\/catalog\/tests$|^\/v1\/billing\/|^\/v1\/identity\/(?:centres|users)$|^\/billing\/accounts\/ledger$/,

Replace it with:

  // LD-404 (T0D-OFFLINE-3): extended again for 9 more already-landed T0D-REGSCREEN-2 frontdesk routes
  // (drafts, custom fields, favourites, ICD lookup, number preview) and the catalog kind lookup route.
  // Each alternative is itemized and anchored (no open prefix on /v1/frontdesk/) so an unrelated
  // frontdesk route, such as /v1/frontdesk/patients, is still rejected.
  route_strings_added: /^\/v1\/catalog\/tests$|^\/v1\/catalog\/\$\{kind\}$|^\/v1\/billing\/|^\/v1\/identity\/(?:centres|users)$|^\/billing\/accounts\/ledger$|^\/v1\/frontdesk\/custom-field-definitions$|^\/v1\/frontdesk\/favourite-tests$|^\/v1\/frontdesk\/favourite-tests\/\$\{uuid$|^\/v1\/frontdesk\/icd-codes$|^\/v1\/frontdesk\/registration-drafts$|^\/v1\/frontdesk\/registration-drafts\/\$\{id$|^\/v1\/frontdesk\/registration-drafts\/\$\{uuid$|^\/v1\/frontdesk\/registrations\/number-preview$/,

EDIT 2 of rs-c4.static.test.ts -- find this exact line:

    expect(LD310_ALLOW.route_strings_added.test('/v1/frontdesk/patients')).toBe(false);

Replace it with:

    expect(LD310_ALLOW.route_strings_added.test('/v1/frontdesk/patients')).toBe(false);
    expect(LD310_ALLOW.route_strings_added.test('/v1/frontdesk/icd-codes')).toBe(true); // LD-404
    expect(LD310_ALLOW.route_strings_added.test('/v1/frontdesk/custom-field-definitions/extra')).toBe(false); // LD-404: still scoped, not a prefix match

That is the whole fix for this LEAD ITEM. Do not touch anything else in either file. Do not touch
the Daily cash snapshot in this round -- still parked, awaiting the founder.

NOTE TO FOUNDER (separate from the LEAD ITEM above, read this part yourself, not the tester):
This is the 6th distinct rs-c4/LD310_ALLOW allow-list category gap found on T0D-OFFLINE-3 alone
this session (LD-391, LD-393, LD-398, LD-400/401, LD-403, now LD-404), every single one caused by
the same root cause: lane C0-0K is a SHARED WORKTREE that keeps re-merging a fast-moving main, so
every other already-approved feature that lands on main (billing accounting, then REGSCREEN-2)
shows up inside OFFLINE-3's own lane as a "new addition" against its frozen pre-restyle baseline,
even though OFFLINE-3's own actual diff has been confirmed unchanged and correct since round 1 (12+
rounds now). I said in LD-403 I would raise this as a standing question rather than keep patching
indefinitely once a 6th gap appeared; this is that 6th gap, so I am raising it now rather than
quietly doing a 7th. The individual fixes have all been small, safe, and mechanically verifiable
(grep the symbol or route back to an already-landed, already-approved task), so I am not blocked
and I am not asking you to approve this specific fix -- it is done. What I am asking is whether the
lane itself should be isolated from main (stop auto-remerging) until OFFLINE-3 is done, or whether
OFFLINE-3 should be fast-tracked to merge now so it stops catching every other team's landed work,
since at the current rate of already-landed features merging into main, this could keep recurring.
This is a lane/process question about how C0-0K is set up, not a feature decision, so it is outside
what I would rule on myself under LD-310.

----
LEAD RULING, LD-409: Daily cash (open shift) snapshot, the 7th rs-c4 allow-list-family gap, same
root cause as LD-391/393/398/400/401/403/404 (shared worktree re-merging a fast moving main pulls
in other tasks already-landed work as new against OFFLINE-3's frozen baseline).

Read the full diff from the verify log. This screen gained its real content elsewhere (stat row:
Gross/Reversed/Net/Variance; a Net-by-payment-method chart with an accessible hidden data table;
a page-status date badge in the header) while OFFLINE-3's baseline still expects the old bare
placeholder markup. Not OFFLINE-3's own regression -- OFFLINE-3 has never touched this file.

Separately flagged, not blocking: the new markup also drops the Business date input's
aria-describedby and its paired BS-calendar hint paragraph that the old markup had. Looks like an
incidental accessibility loss in whatever task built the stat row/chart. Whoever owns the Daily
Cash screen's real implementation should look at restoring it -- not OFFLINE-3's problem to fix,
and not holding OFFLINE-3 up for it.

EDIT: regenerate only the "Daily cash (open shift)" snapshot in rs-c4.screens.test.tsx to match
the screen's current real rendered output (the full diff already shown in the verify log is what
the new snapshot should capture). Do not touch the other 4 snapshots in that file -- Register
(3 cases) and Credit party are passing and out of scope.

If an 8th gap of this same family appears after this, that is a strong enough signal that the
lane-architecture question raised in LD-404 (isolate the lane vs. fast-track the merge) needs an
actual answer rather than another allow-list/snapshot patch -- raise it plainly rather than quietly
patching an 8th one.

Reset: C0-0K T0D-OFFLINE-3 to changes.

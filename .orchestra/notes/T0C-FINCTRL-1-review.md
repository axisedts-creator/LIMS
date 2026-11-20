APPROVE

Scope: the asked range 2859df488..HEAD holds only the tester's ruling change (acctlist1-openapi.test.ts:256-260, ruling and dispute notes). I also read the full task diff 259d250ae^..1043bca8a.

- The test change matches the ruling exactly: it drops the stale page.tsx pin (T0D-UILIST-2, LD-358), keeps the migration check, and retitles the test. Nothing is weakened beyond what the ruling allows.
- billing.yaml: I compared the parsed old and new files. No path or schema was removed. The only changes to existing items are additive: AccountLedgerEntry (status gains held, plus the hold columns and fiscal_year_label), CashSessionDto and CloseCashSessionRequest (previous_outstanding_cash_paisa and deposit_paisa), and the listAccountLedgerEntries filters (fiscal_year_label, held). The raw 1764 deleted lines are text diff noise.
- All 15 new operations carry an x-permission (billing.discount_policy.read or .manage; hold and release use billing.account.manage), the general rate tier, an idempotency setting, and If-Match versioning where they mutate.
- The migration is idempotent. All four new tables have RLS ENABLE and FORCE, tenant policies to lims_app only, and row audit. The overlap trigger runs under an advisory lock. The ledger is append only, enforced by a column-level grant plus guard triggers, and the only status changes are submitted->held and held->submitted. The down note is present.
- The new permission codes are in permissions.yaml and the corp_admin pack. frontdesk.yaml is additive (within_limit).
- Ran: tools/codegen vitest finctrl1/acct1/acctlist1/regparity2/c4: 1288/1288 pass. I did not re-run pgTAP; the debugger's verify run reported it green.
- Not this task's defect: services/api static tests forbid `UPDATE billing.account_ledger_entries`, so T0B-FINCTRL-1 must adjust them for hold and release. Also, the working tree has an uncommitted change to db/tests/fixtures/probe-rows/billing.sql that is not in this task's diff, so commit or drop it before merge.

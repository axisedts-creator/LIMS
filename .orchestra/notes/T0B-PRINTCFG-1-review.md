APPROVE
Range 3461ff5ad..HEAD (bd621da69, c8b2b4f8f, 088878562): only services/api/src/modules/billing/__tests__/accounts/reversal.test.ts changed in code, plus orchestra notes.
- reversal.test.ts:112-126 applies LD-389 / ruling dispute 4 item 5 exactly: 42501 kept for UPDATE amount_paisa and DELETE; status='reversed' now expects P0001 + /immutable_row/, matching migration 20261117190000_billing__add_finance_controls.sql account_ledger_hold_guard; entry re-read via the existing dbEntries owner-side helper and asserted unchanged (toEqual plus toMatchObject, so an undefined row would fail); title renamed per LEAD ITEM 2; LD-389 cited in a comment. No assertion removed or loosened.
- Grep of billing/__tests__ for other status UPDATEs pinned to 42501 on account_ledger_entries: none, so no other file needed.
- No migration, ledger or print code touched (writer made no code change, as the ruling says). No PHI, no secrets, no invented names, owned test path only.
- Impl note records 3x green (pg.sh 4602 pass / 0 fail each run; renderer printcfg 34/34; boot 5/5). The reviewer did not re-run these.

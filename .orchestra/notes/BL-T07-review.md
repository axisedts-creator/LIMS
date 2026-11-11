APPROVE

Reviewed `git diff 76ccce0..HEAD` (BL-T07) against 02-TRD §6.3 and the billing schema migration 20261105001700.

Checked:
- Method names/signatures match TRD §6.3 `BillingCommandPortV1` verbatim. Error codes are only spec'd ones (credit_party_locked, credit_limit_exceeded, order_not_invoiced, version_conflict, validation_failed, not_found, idempotency_key_reused).
- Columns written (credit_accounts party_code/party_display_name/party_pan/party_address; credit_charges INSERT_COLUMNS; credit_note_tasks) all exist. NOT NULL centre_id on credit_note_tasks is satisfied on both paths. The voided status sets voided_at (state check).
- Tenancy: every SQL statement filters tenant_id from ctx. `ANY($2::uuid[])` and `$6::uuid[]` casts are present. Order existence goes through FrontdeskPort; there is no cross-module import. No new tables, so no RLS changes are needed.
- Atomicity: no own tx; ctx.tx is used throughout. The credit-account upsert takes the row lock before the limit check. FOR UPDATE is held on charges before void.
- No logging of PHI, no secrets. All edited paths are owned by billing or are .orchestra/notes.
- Tests: `vitest run src/modules/billing` gives 32 files passed / 3 skipped, 743 tests passed. The shared contract suite (cases 1–15, ⊇ the 11 in done_when) runs on the real impl. The additions cover US-FD-03.x/04.x paths and cross-tenant not_found.
- tsc: no errors in billing. The existing errors are in contracts/ports and packages/shared-ts (not owned, not from this diff).

Non-blocking notes (no change required):
- sumOpenCreditExposure counts uninvoiced charges pre-tax, while `additional` is the net incl. VAT. This is tagged [CONV] in code. Consider raising it with the spec owner.
- raiseCreditNoteRequirement does not dedupe repeat calls (spec silent).

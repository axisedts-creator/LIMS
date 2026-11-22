APPROVE
Scope: assigned range eeb5682..HEAD (t23.transfers.test.tsx:167 per ruling 2, notes) plus the whole FIX-9 work (a021dbea9, 51b45f087, b9045bf8d, 24b2503b8), because the assigned range alone holds none of the implementation.
- t23.transfers.test.tsx:167 matches ruling 2 word for word; no assertion was weakened.
- Names match the contract: billing.yaml getDailyCash = business_date / centre_id / collected_by_membership_id; inventory.yaml set_name = uom|reasons|tax_codes, with reason_group as a query; movement_kind array plus comma string, 1-20 kinds, enum-checked.
- printProfile previewCentre: the IdentityPort scope comes first; core.collection_centres is filtered by tenant_id inside the RLS transaction; no centre gives auth.forbidden or common.not_found, never 500. Permission checks still run before it (tests at fix9.preview-500:98,105). No new permission, migration or contract change. No PHI, no secrets.
- Web: a failed call shows ErrorState/Banner with "Reference: <request_id>" (daily-cash sessions, inventory checklist, wastage reasons, print preview); a 403 keeps the quiet fallback. Each case has a test with a mocked 400.
- Tests (run by reviewer): api fix9 49/49, web fix9 18/18, t23 229/230. The one failure is t23.stock "In transit": FIX-9 does not touch it and it is recorded in -left.md. The listInventoryCodedSet handler is unchanged; settings.codedsets.integration and authz7 tests already cover it on the api side.
- Note, not a defect: 20 non-note files changed against the "16 files" budget. The extra files are the UI error display that done_when (4) requires and the harness/test edits the arbiter ordered.
- Follow-ups already in -left.md: the same fault in print.service.ts:33 workingCentre(); bench/transfers still use soft().

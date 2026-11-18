TESTS_WRONG — the control test (lab.live.test.ts:234-238) assumes its centre a2 fixture rows can be read by USER.a1 under RLS, and the fixture never sets that up. Change only the fixture setup; keep the expectation ['duplicate','duplicate'].
Reasons:
1. The spec policy specimens__select__tenant_centre (spec/program/02-CONVENTIONS.md:670; spec/chunks/C5-lab-workflow/05-SCHEMA.md:1040) shows a row only when app.has_all_centres() is true, or when centre_id or processing_centre_id is in app.current_centre_ids(). Migration 20261105001800:1008-1009 copies it.
2. For actor_type 'user', both helpers read core.memberships and core.membership_centres by the membership_id claim (spec/chunks/C0-foundation-contracts/05-SCHEMA.md:934; spec/program/02-CONVENTIONS.md:631; migration 20261105000400:114-136). With no row, has_all_centres() is false and current_centre_ids() is '{}'.
3. helpers.ts:50 sets membership_id = sub, and the sync tests seed no core.memberships row (grep: 0 hits). So the rows are hidden at DB level whatever the IdentityPort fake returns. The spec requires that RLS outcome (REQ-SEC-017, T-32 "foreign specimen is 404"), so the implementation must not bypass it.
4. A spec-correct implementation therefore answers common.not_found here. The test's premise "the rows above are readable and only the scope hides them" is false.
Required test change, in the describe fixture (beforeAll at :203, cleanup in afterAll at :214):
- For TENANT_A, seed a core.memberships row with id = USER.a1, the user = USER.a1, is_active = true, all_centres = false.
- Seed core.membership_centres rows for CENTRE.a1 and CENTRE.a2, so DB visibility matches what the identity fake says.
- Do not switch the control push to actor_type 'system': that would stop it from controlling the same user path.
- Tests :219 and :227 stay unchanged. With that membership they still need the adapter's own IdentityPort scope check, because DB visibility then includes a2.

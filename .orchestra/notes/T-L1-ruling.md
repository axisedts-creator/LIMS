TESTS_WRONG — the test fixture breaks a spec FK: seeded link_codes point at link_consents rows that do not exist.
Reasons:
1. spec/chunks/C16-patient-engagement/05-SCHEMA.md:328 `link_codes__consent__fk FOREIGN KEY (tenant_id, consent_id) REFERENCES engagement.link_consents (tenant_id, id)`. A real DB cannot hold a link_codes row whose consent is missing.
2. link.handlers.test.ts:72 gives every seeded code `consent_id: ID(0xd00+n)`, but :90 seeds `link_consents: []`. :122 models the FK, and fakeSql.ts:165/185 re-checks FKs on UPDATE, so revoking any seeded code (L2 revoke, L1 supersede) throws 23503. No correct implementation can pass.
3. The behaviour asserted (supersede the oldest of 4 unexpired codes, L2 revoke 204 with revoke_reason) is not disputed and stays as written.
Change in test (tester only):
- Seed one link_consents row per seeded code n=1..10: id ID(0xd00+n), tenant_id equal to the code's tenant (B for n=10), source 'desk', patient_id equal to the code's patient_id, relationship 'self', consented_by 'patient', consent_text_version 'v1', identity_check_method 'photo_id', recorded_by_membership_id A, created_by A.
- The L1 "writes a link_consents row" test (:255-260) must then count only new rows (exclude seeded ids 0xd01..0xd0a) instead of `toHaveLength(1)` / `consents[0]` on the whole table. The same applies to :301 and :376. Their asserted fields do not change.
- Implementation: no change required for these two tests.

APPROVE

T3 review (diff c82eac2..HEAD):
- All 7 edge tables match 03-APP-FLOW §2.1–§2.7 exactly (SS1–SS10, M1–M6 + L1–L2, T1–T5, SP1–SP10, IR1–IR8, §2.6, §2.7); spec "Forbidden" lines hold.
- STATES equal the 05-SCHEMA CHECK sets (sessions__state__ck, support_sessions__status__ck, invitations__status__ck, ird_annex_records__status__ck, audit_exports__status__ck) and C0 core.tenants.status / core.memberships.status (08 A3.3/A3.4).
- Error codes verbatim: identity.annex_invalid_transition (409, 02-TRD), common.validation_failed (AC-E3.1). AC-E3.3 tested; edge check precedes field check.
- Tests: helper asserts every listed edge allowed and every other pair forbidden (covers ">=1 forbidden per state"). Ran vitest on domain/__tests__: 11 files, 521 tests passed.
- Pure modules: no DB/RLS, permissions, logging, secrets in scope. Paths within C2-owned api `identity` module + role notes.

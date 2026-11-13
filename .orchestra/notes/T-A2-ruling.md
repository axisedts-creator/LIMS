TESTS_WRONG — the test world's fake UNIQUE (tenant_id, token_sha256) check treats an UPDATEd row as colliding with its own pre-update self; real Postgres does not.
Change: `services/api/src/modules/engagement/__tests__/otp.world.ts:112` — replace `o !== r &&` with `o['id'] !== r['id'] &&` (an UPDATE passes a copy `next`, line 169, so identity never excludes the original row). Keep the rest of challengeCheck; INSERT behaviour is unchanged (new id never matches an existing row).
Reasons:
- spec/chunks/C16-patient-engagement/05-SCHEMA.md:254 — the constraint is `UNIQUE (tenant_id, token_sha256)`; a row updated without changing token_sha256 cannot violate it against itself (standard Postgres unique semantics: the old tuple version is replaced, not duplicated).
- 05-SCHEMA.md:11 and :1331 — otp_challenges grants U; SYS may UPDATE (policy `otp_challenges__update__system`, :1436).
- 05-SCHEMA.md:1481 — `engagement.send_login_otp` must mark earlier challenges `superseded` as the system actor (TRD §4.1 step 2), so the UPDATE path the worker tests exercise is spec-required.
- The 9 failing `send_login_otp.test.ts` cases fail on this fake-DB artefact, not on any spec rule; no implementation change is required by this ruling.
- After the fix, the tests must still fail on a real duplicate token (two distinct ids, same tenant + token_sha256) — tester should keep/add that case.

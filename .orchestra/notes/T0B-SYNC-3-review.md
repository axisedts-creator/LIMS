APPROVE
Scope 39cd0d394..HEAD: test fixture only (lab.live.test.ts:205-208, 219-220) plus notes; no production code changed.
- Fixture follows the arbiter ruling exactly: it seeds core.memberships (id = user_id = USER.a1, actor_type 'user', all_centres false, status 'active'; is_active is generated) and core.membership_centres for CENTRE.a1/a2. Columns and FKs match migration 20261105000400:38-99. afterAll deletes in FK order.
- Expectation ['duplicate','duplicate'] kept. Tests :219/:227 unchanged. Nothing skipped or loosened. Control push still runs as actor_type 'user'.
- No PHI, no secrets. Only owned test paths changed. Names copied verbatim from the schema.
- Risk, not a defect: USER.a1 and TENANT_A are fixed UUIDs shared by the sync test files (maxWorkers 3). While this describe runs, USER.a1 can see centre a1/a2 rows in other files running at the same time. No other sync test seeds or depends on that membership (grep). Writer reports pg.sh 102/102 on three runs. The reviewer did not re-run.

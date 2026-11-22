TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
1. settings/settings.test.ts local `refused` (line 39) treats `path='*'` as a literal path; spec requires errors[].path to be a JSON Pointer
   (spec/program/02-CONVENTIONS.md:415, :427), so a literal '*' can never legally appear. Kit convention already defines '*' = "any field path"
   (services/api/src/modules/partners/__tests__/sales/helpers.ts:81). Change line 39: if path === '*', expect some errors[].path to be a string
   starting with '/'; else keep the toContain(path) check. Lines 182 and 230 then stay as written.
2. boot.test.ts IMPLEMENTED (tester-owned, line 45) must list 'updatePartnerSettings' (comment: T0D-BUILD-2, LD-447). The task brief done_when (2)
   orders the stub replaced by a real handler (contracts/openapi/partners.yaml:6087); the T01 stub tests (lines 126-136) then wrongly
   classify a real handler as a stub. getPartnerSettings is already excluded at line 117; optionally also add it to IMPLEMENTED and drop the
   line-117/111 pending special case, since BUILD-2 replaces the LD-446 501 (only if contract/fix2.settings-pending.test.ts is retired in the same change).
Tester applies both edits; no implementation change required by this ruling. Writer's code is untested on PG17 (no Docker): tester must run the suite before merge.

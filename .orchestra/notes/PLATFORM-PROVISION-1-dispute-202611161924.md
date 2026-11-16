# PLATFORM-PROVISION-1 dispute (debugger)
Verify red = 3 tests in tools/codegen/__tests__/identity-openapi.test.ts (950/953); all provision tests green (api 17/17 + 176/176, web 26/26 + 121/121).
Not caused by this task: `listRolePacks` / `applyRolePack` entered contracts/openapi/identity.yaml in commit 9fd800f65 (RM-T05); this task's yaml diff touches only TenantProvisionRequest.
Failures: (1) lint rule 4: role-packs ops have no request/response example; (2) inventory test: yaml has 2 more ops than 02-TRD §5 (test reads the TRD); (3) Prism smoke: GET /v1/identity/role-packs 200 has no example.
Fix lies outside this task: (1)(3) need yaml examples on RM-T05 ops, which brief item (1) forbids ("no other contract line changes"); (2) needs spec 02-TRD §5 to list the 2 ops, and spec/ is read-only for agents. I will not weaken the tests.
Needs: lead to reset to RM-T05 owner (examples + TRD §5 CR), or waive these 3 tests for PLATFORM-PROVISION-1.

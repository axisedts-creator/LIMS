# T0D-PORTOWN-1 impl (LD-305)
- Changed: services/api/src/core/ports/registry.ts portsFor getter only: `consumers[port]?.includes(module) || owners[port] === module`. No change to PORT_CONSUMERS, contracts, modules, assertRole.
- [CONV] `owners` is the resolvePorts option (default PORT_OWNERS), so the owner check uses the same table the boot check validates.
- Tests: src/core/ports/__tests__ 160/160 pass. tsc --noEmit clean.
- audit.chain.test.ts: 74/81 pass; PORT_CONSUMERS pin passes. Without fix: 47 fail. With fix, 7 still fail. All 7 are in "authz mode shadow: nobody gets in without the permission": create/list/getAuditExport as reader/nobody should give auth.forbidden. That is shadow-mode assertRole work in T0B-ADMINFIX-1 (arbiter TESTS_WRONG ruling), so out of scope here.
- DONE_WHEN (5): per tester grep, only identity reads its own port (IdentityPort: modules/identity/index.ts, service/audit-export.service.ts). Check the identity audit view and audit export on staging.
- Not run: DB-backed module suites (LIMS_TEST_APP_URL not set).

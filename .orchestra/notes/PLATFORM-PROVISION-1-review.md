APPROVE

Scope reviewed: the range a991f7d9f..HEAD (only notes: debug.md round 4 and impl.md) plus the task code it rests on, 188ce5364 (tests) and 9677e24a3 (impl).

- Contract: TenantProvisionRequest gains contract_acceptance, which is required, has additionalProperties false, and holds tos and dpa. Each has version 1..32, accepted_by_name 1..120, accepted_by_title 1..80 and accepted_at using IsoUtc. These limits equal accInput in tenant.service.ts:302-311. The request example was updated. No other contract line changed.
- Handler (provisionTenant.ts:6,12,18) already maps the snake_case keys to the camelCase names the service reads. The service, db, policy, migration and auth code are not touched, and no tenant-isolation or RLS code is in the diff.
- Form: the Contract acceptance section has one acceptor and one time for both documents. accepted_at defaults to now and is sent with toISOString (UTC, 3 ms digits), which matches IsoUtc. No version string is hard coded. Client maxLengths come from ACCEPT_MAX, which equals the service limits. Single-flight and the idempotency key are unchanged, and tests cover both: double click, and a 503 retry that reuses the key.
- Action: re-validates on the server side and then sends the exact keys only (pickAcceptance), with LD-29/LD-275 cited in comments.
- Tests: provision-contract.test.ts compiles the real request schema with the core/openapi.ts AJV options. It validates the shared fixture that the form test proves equal to the body the form sends, and it refuses the body without contract_acceptance or without accepted_by_title, naming the field path. This covers done_when (4).
- Generated copies (api-client-ts/dart, fakes, routes) were regenerated from the contracts. The regeneration also brought in drift that was already in the contracts (role-packs ops, quality "excluded"). It is generator output, not a contract edit, and is needed for codegen freshness. Not a defect.
- Names are copied verbatim, data is synthetic, there are no secrets, no PHI is logged, and all paths are inside the task's file list.
- Note, not a defect in this task: the round-4 debug finding (ANSI codes break the wrapper's findstr) is in the lead-owned C:\LIMS-state\verify-prov1.cmd. The lead needs to set NO_COLOR=1 or loosen the findstr pattern, or verify keeps failing even though the code is green.

```
Title: CR-C1-PROV-001: 02-TRD §5 and identity.yaml examples behind CR-C2-RM-001 (listRolePacks, applyRolePack)
From chunk: C1            To owner: C0-0C (contracts/openapi/identity.yaml examples); doc owner/founder (spec/chunks/C2-identity-admin/02-TRD.md §5.4, spec/program/08-CR-REGISTER.md)
Type: api
Blocking? no for PLATFORM-PROVISION-1 (its own tests are green). Yes for a green tools/codegen/__tests__/identity-openapi.test.ts (3 red: 950/953).
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  CR-C2-RM-001 (.orchestra/cr/RM-T05.resolved-202611131758.md) added GET /v1/identity/role-packs (listRolePacks) and
  POST /v1/identity/role-packs/apply (applyRolePack) to contracts/openapi/identity.yaml (commit 9fd800f65, RM-T05).
  04-CHANGE-REQUESTS §3 rule 5 ("Documents follow code") was not applied: 02-TRD §5 has no rows for them and 08-CR-REGISTER
  does not list the CR. The contract test for AC-0C-1.4/1.5 (identity-openapi.test.ts) therefore fails:
  (a) lint rule 4: the role-pack ops have no request/response examples;
  (b) inventory: identity.yaml has 2 operations that are not in 02-TRD §5;
  (c) Prism smoke: GET /v1/identity/role-packs 200 has no example.
Proposed change (exact):
  1. spec/chunks/C2-identity-admin/02-TRD.md §5.4: add rows for `listRolePacks` GET `/role-packs` and `applyRolePack`
     POST `/role-packs/apply`. Copy permission, idempotency, tier, request, response and errors verbatim from CR-C2-RM-001.
  2. contracts/openapi/identity.yaml: add a request example to applyRolePack and 2xx response examples to both operations.
     The examples must validate against the schemas already in the file. No schema changes.
  3. spec/program/08-CR-REGISTER.md: record CR-C2-RM-001 as applied.
Backward compatible? yes. Documentation plus examples only; no schema or behaviour change.
Tenant/security impact: none. No RLS change, no new field, no new surface (the operations already exist).
IRD/regulatory impact: none.
Alternatives considered: waive the 3 tests (rejected: that weakens AC-0C-1.4/1.5); fix them inside PLATFORM-PROVISION-1
  (rejected: its brief says "no other contract line changes", and spec/ is read-only for agents).
Tests that will prove it: tools/codegen/__tests__/identity-openapi.test.ts 953/953, with no change to the test.
```

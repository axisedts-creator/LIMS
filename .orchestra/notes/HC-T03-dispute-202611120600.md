# HC-T03 dispute — 2 failures, both test faults; impl correct, no code changed

1. `repositories.test.ts` "list with the OTHER tenant's parent id … id swap probe" (collections spec, line 57-58 of test).
   `listArg: () => []` means `listHeldCollections(tx, TENANT[s])` is called with no parent id, so the probe asks for tenant A's own held rows and expects `[]`.
   Impl query is `WHERE tenant_id = $1 AND status = 'held'` (05-SCHEMA.md:478 index `collections__tenant_id_held__p_idx`) — correct; no cross-tenant leak (tenant_id of every row === the tenantId passed). The id-swap probe has no id to swap for this list; it must be skipped for collections or `listArg` must supply the centre_id.

2. `repositories.test.ts:266-268` listVisitsByRoute test seeds `status:'assigned'` with `order_id: null`.
   Spec 05-SCHEMA.md:267 `visits__order_when_active__ck CHECK (status IN ('unassigned','cancelled') OR order_id IS NOT NULL)` forbids it (also 02-TRD.md:247). Fixture must set `order_id` (and `kind` booking requires its own order rules per 05-SCHEMA.md:262-265).

Stopped per rules: tests may not be edited by the debugger. Tester role to fix fixtures.

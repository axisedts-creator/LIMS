# T-Q2 dispute — close_queue_day.test.ts, case "payload tenant_id but ctx without tenant"
- `setup(nowIso, tenantId: string | undefined = TA)` (line 27): a default parameter replaces an explicit `undefined`, so for this row `ctx.tenantId` is TA, not undefined (line 113 passes `undefined` via `tenantId`).
- The case is therefore identical to the matching-tenant run (payload TA, ctx TA); the job correctly runs 1 UPDATE, the test expects 0 calls. No implementation can pass both this case and "matching tenant: UPDATE runs".
- Fix in the test (not mine to edit): build ctx with `tenantId` taken from the argument list length / a sentinel (e.g. `null`), or use `arguments.length`, so ctx.tenantId really is undefined.
- Impl guard is `ctx.tenantId !== payload.tenant_id -> return` and handles ctx.tenantId undefined; the other 3 guard cases pass.

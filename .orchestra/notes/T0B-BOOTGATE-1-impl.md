# T0B-BOOTGATE-1 impl
- module.ts: `ModuleManifest.pendingOperations?`; `checkHandlers(name, spec, handlers, pending=[])` validates string array/no dupes, pending id not in spec = error, missing = error unless pending; returns stale ids (`LoadedModule.stalePending`).
- bootstrap.ts: one `app.log.warn` per stale id (event pending_operation_stale); production gate reads process.env NODE_ENV / LIMS_ALLOW_PENDING_OPS (exactly "1"), stale included.
- openapi.ts: `mountSpec(..., pending)` resolver mounts a 501 stub handler for pending ids without handler, inside normal pipeline (auth, validation, permission, tenant; >=400 rolls back + releases idempotency key). Handler wins on stale.
- errors.ts: `pendingProblem()` builds problem+json (code operation_pending, detail names the operationId, instance = route template, request_id) marked rendered so stage 12 passes it. [CONV] not via toProblem: code not in errors.yaml.
- billing (24 ids, ACCT-1/2) + frontdesk (18 ids, REGAPI-2) pending lists, taken from running the check on merged main.
- OPEN: src/__tests__/real-modules-boot.test.ts has a 60s timeout; full real boot now measures ~72s on this machine (profiled: ~30s autoload+pipeline, ~1-3s per module mount, 9s ready; stubs not the cost). It times out when all specs mount; lead/tester should raise that timeout (pending-operations.test uses 120s).
- Release gate test runs only with LIMS_RELEASE_GATE=1 (tester deviation, kept).

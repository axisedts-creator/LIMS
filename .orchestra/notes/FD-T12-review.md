APPROVE
Re-review of `git diff 0d9a723c..HEAD` after the fix commits f688ef89 (tester) and 3d7a08d4 (writer).

Previous item 1 is resolved. F12 `confirmPreRegisteredOrder`, F22 `listOrderFlags` and F23 `resolveOrderFlag` are now real handlers, wired in handlers/index.ts, and their three operationIds are removed from pending.json (LD-70).
- Contracts match 02-TRD:205,216,217: permissions, Idempotency-Key, If-Match, `common.immutable_record`, and the `note` 500-character limit.
- F12 locks the order row, then checks centre scope (404), status (immutable_record) and version (version_conflict), in that order. It then reuses the F9 createInTx path on the existing row: registration_no and the first-order flag are kept, and exactly one `frontdesk.order.created.v1` is emitted, carrying the stored source.
- F22/F23 filter by tenant, apply centre scope through IdentityPort, cast to `::uuid[]`, and bind every value as a parameter. F23 locks the flag row FOR UPDATE, so a second resolve waits and then gets `common.immutable_record`. The note is never logged.
- Tests cover US-FD-12.2, F22 and F23: permission, RLS and centre scope, immutable, If-Match, validation, keyset paging and rollback.

Checks re-run by the reviewer: static suites flags.static + consumers.static, 27/27 pass (`--fsModuleCache=false`). The only `tsc` error is the existing one at contracts/ports/common.ts:33, which is outside this diff. The DB suites were not re-run here; the writer reports FD-T12 113/113 on PG17.

Not blocking, already recorded as [CONV]/OPEN in FD-T12-impl.md:
- F23 does not check `resolution_code` against the `flag_resolutions` coded set (05-SCHEMA:1862). This matches the FD-T09 cancel-reason convention.
- F12 does not retry once on counter_busy/40P01 (CR FD-T06-retry-quote-ext).

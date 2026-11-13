APPROVE

Reviewed `git diff e3328ae4..HEAD` (HC-T10, A1 registerPhleboDevice / A5 signOffPhleboDevice, US-13-2).

- Names match the spec exactly: operationIds, `homecollection.sync.upload` (HOMECOLLECTION_PERMISSIONS[5]), `homecollection.device_not_registered` (409), `homecollection.unsynced_changes` (409), `homecollection.app_version_unsupported` (426, CR-C17-007), `common.id_mismatch` (400), and the headers `x-lims-device-id` / `x-lims-app-version` (02-TRD §5 preamble, §5.2 A1/A5, device-id binding).
- Tenant isolation: no new DDL. Every read and write is scoped to the tenant through the repo (`tenant_id = $1`). `insertDeviceIfAbsent` uses `ON CONFLICT (id) DO NOTHING` and then re-reads the row within the tenant, so a cross-tenant id gets 409 with no leak. The tests check this with RLS on and with RLS bypassed.
- Membership comes from `ctx.actor.membershipId` and never from the body; a body `membership_id` is rejected as an unknown field. The binding check runs before the seq check. A `wipe_requested` device gets 409 on A5 and is never undone by A1. A `signed_off` device on A5 is a 204 no-op.
- Idempotency and rate tier are left to the core pipeline, as the spec says (A1 Idem required, A5 optional, tier `general`).
- Logs: only `{code}` is logged on the staff-name fallback. No PHI and no device values in logs. No secrets.
- Paths are all owned by C17. `devices.repo.ts` and `settings.service.ts` only gained additions.
- Tests: I ran `tests/homecollection/HC-T10.pg.sh` against PG17 in docker: 3 files, 42/42 passed. They cover the done_when items: probes 1/5, sign-off 409 when the seq is missing, wipe_requested -> 409.

Non-blocking notes (spec ambiguity, not defects):
- 426 is enforced on A1 only, not on A5, so an outdated app can still sign off. The preamble says A* "may return" 426. Worth confirming with the arbiter.
- In A1, body validation runs before the header `id_mismatch` check. Both are 400 responses, so there is no behavioural risk.
- `__tests__/boot.test.ts` IMPLEMENTED list is stale (the writer's note says so). This is outside HC-T10.

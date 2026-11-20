# CR SEC-AUTHZ-1.1 (non-blocking): central authorization stage, design and spec amendment text

From: C1-infrastructure-ops, task SEC-AUTHZ-1 (read-only design, LD-235). To: C0 (owner of 02-TRD 6.2 and 07-SECURITY AB-5), lead, founder (SEC-GATE-2).
Status: design only. No service, contract, db or spec file was changed. Nothing here is implemented until the founder approves the amendment and the lead sets SEC-GATE-2 to done.
Evidence: `tests/security/classify-authz.mjs` (static classifier) and its snapshot `tests/security/authz-classification.json`. Source of the audit finding: security audit 2026-11-15, check 3.3.

## Intent

Make the contract's `x-permission` the thing the core actually enforces, in one place, before a handler runs. Today the spec says authorization is checked and the code only records that someone asked.

C0 02-TRD 6.2, stage 9 (authz guard):
> in dev/ci/staging: non-public operation returning < 400 without an `assertRole` call → `500 common.internal`, log `authz_not_asserted` (AC-0D-2.4). In production, log + metric `lims_core_authz_not_asserted_total` only.

C2 02-TRD 7.2 (`assertRole(ctx, req)`), steps 3 and 5:
> 3. `platform.*` permission → `auth.forbidden` (platform permissions are checked by `PlatformAuthz` in platform context only).
> 5. Permission ∉ `profile.permissions` → `auth.forbidden`.

C0 07-SECURITY AB-5:
> A module handler forgets `assertRole` | dev/ci/staging `500` + `authz_not_asserted`; production metric/alert | authz-guard tests

Gap: stage 9 detects that `assertRole` was called, not what was asked. A handler may call it with any permission, or (in production) not call it at all and still return 2xx. AB-5 is therefore a detector, not a control. The intent of this CR is a control: every operation's declared `x-permission` is asserted by the core before stage 8, and the stage 9 detector stays as a second line.

## Current behaviour

Counts come from the classifier snapshot (1018 operationIds, each in exactly one class). They reconcile with verifier A of the 2026-11-15 audit (607 guarded, 108 unguarded 2xx, 148 no assert, 97 inconclusive, 33 stub, 25 public) as explained below the table.

| class | count | meaning |
|---|---|---|
| public | 13 | `x-public`, no scheme (liveness, readiness, result page, QR verify, identity recovery and mobile or patient pre-auth) |
| identity-session-flow | 6 | `bffSession` operations: loginStaff, verifyMfaChallenge, startMfaEnrolment, completeMfaEnrolment, resolveSession, logoutSession |
| scheme-callback-token | 6 | payment launch and callbacks (4) and the two reporting provider callbacks (path token) |
| scheme-device | 9 | `deviceToken` (8) and `queueDisplayToken` (1) |
| scheme-portal | 9 | `portalSession` |
| scheme-patient-pre-auth | 3 | `patientPreAuth` |
| platform | 34 | `x-permission` is `platform.*` |
| guarded-exact | 604 | a handler path asserts exactly its `x-permission` |
| guarded-other | 55 | a handler path asserts only other permissions (upper bound, see limits) |
| unguarded | 211 | implemented, bearerJwt, no `assertRole` reachable from the handler |
| stub | 38 | no handler definition; the module stub answers `common.internal` or 501 |
| inconclusive | 30 | `assertRole` is reachable but the code is not a literal or same-module constant; each is listed in the snapshot with a reason |

Reconciliation with verifier A. The 25 public operations equal the classifier's `x-public` operations (public 13 + identity-session-flow 6 + scheme-callback-token 6 = 25). The other 993 operations carry `x-permission`: verifier A split them 607 + 108 + 148 + 97 + 33 = 993; the classifier splits them guarded 659 (604 + 55), unguarded 211, stub 38, inconclusive 30, platform 34, device or portal or patient scheme 21 = 993. Differences, stated plainly: (a) verifier A's "108 unguarded 2xx" and "148 no assert" are one class here (unguarded); a static pass cannot tell whether a path returns 2xx. 108 + 148 = 256 against 211 plus the part of inconclusive and platform that verifier A counted there. (b) The classifier carves out platform (34) and scheme (21) operations by contract, which verifier A counted inside its other classes. (c) Inconclusive falls from 97 to 30 because the classifier follows same-module calls, namespace imports and constants. (d) Stub is 38 against 33: five operations have no handler definition by name. Verifier A's per-operation list is outside the repository, so the match is by totals, not row by row; the lead should diff the two lists before SEC-GATE-2.

Limits of the classifier (it never runs a handler): it follows same-module calls to depth 6; a permission code found anywhere in the reachable code counts as asserted, so guarded-other is an upper bound and guarded-exact can be true for a path that is not taken; calls through `ctx.services` or `ctx.ports` objects other than same-module imports are not followed.

Code facts (main 6f4c0d31, confirmed by the lead):
- `core/ports/authz-guard.ts:48` throws `common.internal` only when `LIMS_CORE_ENV` is not production; in production it logs and counts.
- `core/ports/authz-guard.ts` stage 9 records that `IdentityPort.assertRole` was called, not which permission.
- One identity service file calls `assertRole`: `identity/service/audit-export.service.ts:121`.
- `inviteUser` (`identity/service/user.service.ts:387-412`) checks tenant and actor through `scope()` (:227) only, so any staff session can invite a user with any role.
- `approveSupportSession`, `denySupportSession`, `revokeSupportSession` (`identity/service/tenant-access.service.ts`) check no permission. All four are class unguarded in the snapshot.
- The session-kind check is skipped for module routes (`identity/claims/resolver.ts:23,88-94`).
- `assertRole` rejects `platform.*` (`identity/ports/IdentityPort.impl.ts:229`), and checks centre or branch scope only when one is passed (`:223-241`).
- Comments claim the core enforces `x-permission` (`identity/handlers/user.http.ts:1-2`, `billing/handlers/ledger.handlers.ts:2`, catalog `masters.handlers.ts:1`). It does not.
- Unguarded by module of the x-permission prefix: catalog 64, identity 52, reporting 40, billing 30, payments 13, audit 5, inventory 4, anatomic 3.

## Proposed central stage

A new pipeline step runs after stage 7 (the transaction and request context exist, so `assertRole` can read) and before stage 8 (the handler). Name: `authz central`. Stage 9 stays unchanged.

1. Input is the already parsed contract: the operation's `x-permission`, `x-public`, and `security` scheme. No second parse.
2. Operation is `x-public`, or its scheme is `bffSession` (identity session flow): skip. They carry no staff permission; their own resolver authenticates them.
3. Actor kinds. A `user` actor with a bearerJwt: call `IdentityPort.assertRole(ctx, { permission: <x-permission> })` without centre. This is the baseline: it proves the role grants the permission at all, rejects `mfa_pending` and `password_setup` sessions (C2 02-TRD 7.2 step 2), and gives the platform-without-support-session rule (step 4). Handlers keep asserting a centre or branch where the data has one, because only the handler knows the row's centre.
4. `system` actors (worker, jobs): the permission must be in the module manifest's `systemPermissions`; otherwise deny. Unknown system actors hold no permission (WIRE-ID).
5. `device` actors (`deviceToken`, `queueDisplayToken`): the resolver of the owning module already authenticated the credential; the central stage checks that the device credential carries the operation's `x-permission` (instruments ingest codes) and denies otherwise.
6. `patient`, `partner` and `portal` actors (`patientPreAuth`, `portalSession`, partner sessions): they must never reach an operation whose scheme is bearerJwt staff. The stage denies any `patient`, `partner` or `portal` actor on a bearerJwt operation with `auth.forbidden`, and checks the scheme's own permission for operations that declare one.
7. `platform.*` operations (34): `assertRole` cannot be used (it rejects `platform.*`). The stage calls `PlatformAuthz` (C2 02-TRD 7.2 step 3; CR-C0-004), which already exists in `identity/platform/authz.ts`, with the same `x-permission`. A tenant actor on a `platform.*` operation is denied.
8. Operations whose handler deliberately checks a different permission (55 guarded-other candidates, for example billing reprint on invoice read paths and catalog read paths that need a manage code): the stage reads a reviewed exception file `services/api/src/core/pipeline/authz-exceptions.json` (new) with `operationId`, `handlerPermission`, `reason`. For these the central stage asserts the handler permission instead of `x-permission` only when the entry exists. Every guarded-other row not in the file is denied centrally and shows up as a false deny in shadow mode, which forces one of two fixes: correct the contract `x-permission` (a C0 or owner CR) or add a reviewed exception. No silent allow.
9. Failure result: `auth.forbidden` (403), `auth.mfa_required`, or `identity.support_session_required`, as `assertRole` already throws; the central stage adds the log event `authz_central_deny` with `operation_id`, `actor_type`, `permission`, `mode`, and no ids of people.

## Mode

`LIMS_CORE_AUTHZ_MODE=shadow|enforce`.
- `shadow`: run the central check, log `authz_central_deny` and count `lims_core_authz_central_deny_total{operation_id}`, but do not block; the request goes on to the handler. Used on staging first so false denies can be measured against real flows (guarded-other, exceptions, centre-less reads) before anything is blocked.
- `enforce`: a deny returns the error and the handler does not run.
- Default when the variable is unset: `enforce` in production. In any other `LIMS_CORE_ENV` it is set to `shadow` in the deploy config until the staging report shows zero unexplained `authz_central_deny` over the agreed soak window. A value other than `shadow` or `enforce` stops the process at boot. Running production in `shadow` needs the founder's recorded decision; it is never the production default.
- Stage 9 is unchanged and keeps both behaviours of 6.2 (500 off production, metric in production).

## Exact spec amendment text

Proposed replacement for C0 02-TRD 6.2, stage 9 row, and a new stage 8a row inserted before stage 8:

> 8a | authz central | before the handler, for every operation that is not `x-public` and not `bffSession`: the core reads the operation's `x-permission` from the parsed contract and calls `IdentityPort.assertRole(ctx, { permission })` without centre (user actors); `PlatformAuthz` for `platform.*`; the manifest `systemPermissions` for system actors; the credential's own permission for device actors; patient, partner and portal actors are denied on bearerJwt operations. A deny returns the `assertRole` error (`auth.forbidden`, `auth.mfa_required`, `identity.support_session_required`) and logs `authz_central_deny`. Handlers still call `assertRole` with `centreId` or `branchId` when the data has one. An operation whose handler must check a different permission is listed with a reason in `core/pipeline/authz-exceptions.json`; no other exception exists. `LIMS_CORE_AUTHZ_MODE=shadow|enforce` (default `enforce` in production); in `shadow` the deny is logged and counted (`lims_core_authz_central_deny_total`) and the request continues.
>
> 9 | authz guard | second line, unchanged: in dev/ci/staging a non-public operation returning < 400 without an `assertRole` call → `500 common.internal`, log `authz_not_asserted` (AC-0D-2.4). In production, log + metric `lims_core_authz_not_asserted_total`. Operations tagged `x-context: identity_auth` are exempt (08 A25 D-212).

Proposed replacement for C0 07-SECURITY AB-5:

> AB-5 | A role without the operation's `x-permission` calls the operation, or a module handler forgets `assertRole` | the central stage answers `403 auth.forbidden` (or `auth.mfa_required` / `identity.support_session_required`) before the handler runs, log `authz_central_deny`; a handler that still forgets its own centre or branch `assertRole` is caught by stage 9 (dev/ci/staging `500` + `authz_not_asserted`; production metric/alert) | authz-central tests (behaviour matrix) and authz-guard tests

C2 02-TRD 7.2 needs no change; step 3 already states that `platform.*` is checked by `PlatformAuthz`, and the central stage is the first caller that honours it.

## Impact

Extra database reads per request, against the T-26 3.0 s p95 target: for a non-privileged user operation, `assertRole` uses the actor profile already resolved by the claims resolver (C2 02-TRD 7.2 step 2 reads `getActor(ctx)`), so the central stage adds no new read in the common case and one read when the profile is not yet memoised for the request. A privileged permission (registry `privileged: true`) re-reads membership and role grants without memo (C2 02-TRD 7.2 step 7a): one extra read per privileged request. Handlers that already call `assertRole` repeat the check, which the per-request memo absorbs. These are estimates from the spec text, not measurements. The `shadow` mode on staging is the measurement: compare the T-26 run p95 with and without the stage and attach both to the staging report; if the p95 grows by more than the budget the lead sets, memoise the baseline result per request (key: actor, permission) before enforcing. Risks: false denies on the 55 guarded-other and 30 inconclusive operations (handled by shadow and the exception file); stub operations (38) are unaffected until they get a handler.

## Test plan

1. The classifier is a completeness test: `node --test tests/security/authz-classification.test.mjs` fails if a new operationId appears without a class, if a class count changes unreviewed (snapshot diff), or if `inconclusive` is not listed with reasons. After implementation the classifier must show unguarded 0 for operations the central stage covers; the snapshot is regenerated in the same task and the diff is reviewed.
2. Behaviour matrix (new test, one sample per module group, run against the in-process pipeline with a fake `IdentityPort`): for a sample of operations from every module (identity, catalog, frontdesk, billing, lab, instruments, reporting, analytics, quality, micro, anatomic, inventory, partners, smartreport, payments, engagement, homecollection):
   - a user whose role lacks the `x-permission` gets `auth.forbidden` and the handler spy is not called (enforce); in shadow the handler is called and `authz_central_deny` is logged;
   - a user with exactly the permission reaches the handler;
   - a `patient` session and a `partner` session are denied on staff operations; a `portal` actor is denied on a bearerJwt operation;
   - a session in `mfa_pending` is denied with `auth.mfa_required`; `password_setup` with `auth.forbidden`;
   - a tenant actor on a `platform.*` operation is denied; a platform actor without a support session on a tenant operation gets `identity.support_session_required`;
   - the four named gaps: `inviteUser` by a staff role without `identity.user.manage` is denied; `approveSupportSession`, `denySupportSession`, `revokeSupportSession` by a role without `identity.settings.manage` likewise.
3. Mode tests: unset in production means enforce; an unknown value stops boot; shadow logs and counts but never blocks; enforce blocks before the handler.
4. Exception file test: every entry names an existing operationId and a non-empty reason; every guarded-other operation is either in the file or has its contract corrected.
5. No log line or metric label carries a token, email or person id.

## Task list

All tasks are queued behind SEC-GATE-2 (status blocked; the lead sets it done after the founder approves this amendment) and run in lane C1 order. The lead writes the final task rows; the files and done_when below are the proposed content. Each task is its own commit with tests; behaviour on staging stays shadow until the last task.

1. SEC-AUTHZ-2 central stage in the core. files: `services/api/src/core/pipeline/authz-central.ts` (new), `services/api/src/core/pipeline/index.ts`, `services/api/src/core/pipeline/authz-exceptions.json` (new), `services/api/src/core/ports/authz-guard.ts` (comment only), unit and integration tests under `services/api/src/core/pipeline/__tests__/`. done_when: stage 8a exists, reads `x-permission` from the parsed contract, `LIMS_CORE_AUTHZ_MODE` works as in Mode, the behaviour matrix passes for a fake module, and stage 9 tests still pass.
2. SEC-AUTHZ-3 platform guard. files: `services/api/src/core/pipeline/authz-central.ts`, `services/api/src/modules/identity/platform/authz.ts` (read use only), tests. done_when: all 34 `platform.*` operations call `PlatformAuthz` centrally; a tenant actor is denied; the snapshot class platform is unchanged.
3. SEC-AUTHZ-4 identity module group (52 unguarded). files: `services/api/src/modules/identity/service/user.service.ts`, `tenant-access.service.ts`, `services/api/src/modules/identity/handlers/*.ts` as needed, tests. done_when: `inviteUser`, `approveSupportSession`, `denySupportSession`, `revokeSupportSession` and the other unguarded identity operations are denied for a role without the permission; the identity rows of the exception file are reviewed.
4. SEC-AUTHZ-5 catalog and pricing group (64 unguarded, most guarded-other). files: `services/api/src/modules/catalog/**` handlers and services, the exception file rows for catalog, tests. done_when: every catalog operation is guarded-exact, in the exception file with a reason, or its contract `x-permission` is corrected by a C3 CR.
5. SEC-AUTHZ-6 billing, payments and audit group (30 + 13 + 5 unguarded, 7 billing reprint rows). files: `services/api/src/modules/billing/**`, `payments/**`, `identity/service/audit-export.service.ts`, tests. done_when: the billing reprint and audit export permission differences are resolved by exception or contract CR, and the group has unguarded 0.
6. SEC-AUTHZ-7 reporting, inventory and anatomic group (40 + 4 + 3 unguarded). files: `services/api/src/modules/reporting/**`, `inventory/**`, `anatomic/**`, tests. done_when: unguarded 0 for the group; the narrative write and sign rows resolved.
7. SEC-AUTHZ-8 inconclusive and remaining modules (30 inconclusive: frontdesk, homecollection, payments, engagement, lab). files: the module services that take the permission from an imported table, tests. done_when: inconclusive 0 in a regenerated snapshot, each operation guarded-exact or in the exception file.
8. SEC-AUTHZ-9 staging soak and enforce. files: `.env.example` and the deploy config for `LIMS_CORE_AUTHZ_MODE` (the lead names the owned path), `docs` note, T-26 run result. done_when: staging runs in shadow with zero unexplained `authz_central_deny` for the agreed window, the T-26 p95 with the stage is within the budget, the C0 spec amendment is applied by its owner, and staging is switched to `enforce`.

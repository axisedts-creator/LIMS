Title: CR-C1-DEPLOY-007: first real "forgot password" test through the test edge: task scope bug, worker without GoTrue, no mail templates (night12, night13)
From chunk: C1 (deploy attempt, prod-lean, 2026-11-21)    To owner: per item (listed below)
Type: bug
Blocking? yes for production go-live (no user can ever set a first password or accept an invitation); no for any current orchestra task, so this file is named `.nonblocking`.
Relation to earlier CRs: 001 to 006 covered images, database, app stack, identity wiring and the edge. 004 item 1 fixed the platform cron payload in `tasklist.ts` (night8); this CR is the same code path seen from the non-cron side. Fixes exist in the deploy copy on the host and in `DEPLOY-AXIS-NIGHT12.patch` and `DEPLOY-AXIS-NIGHT13.patch` (held by the deployer, not in the repo). Evidence per item: (verified) = I checked it in the repo; (reported) = night report from the host, not re-checked by me.
Outcome on the host: after the fixes, "forgot password" returns 202, the job runs and the Brevo relay delivers a mail. The mail's link, the password set and TOTP enrolment through the new templates are NOT yet proven (needs one real reset by the operator).

## Items

### 1. Tasks without a crontab entry are always `per_tenant`, so tenantless enqueues fail with HTTP 500  (To: C0-0D / owner of `services/worker`, C2 identity) (code and live registry verified)
Problem: `services/worker/src/core/tasklist.ts:61` registers every task without a crontab entry as `per_tenant` (`[CONV] module tasks are tenant jobs unless a crontab says platform`). `identity.send_recovery` is enqueued by `requestPasswordRecovery.ts:54` inside `identityAuthTx` with no tenant claims. `app.enqueue_job` (`db/migrations/20261105001200_app__create_queue_wrapper.sql:20-22`) raises `job_tenant_mismatch` (SQLSTATE P0001) for a `per_tenant` task without a tenant, so `POST /v1/identity/auth/password/recover` returns 500 `common.internal` and no job exists. Live registry before the fix: `identity.send_recovery scope=per_tenant` (verified by query on the host). Night12 reproduced the exact error as `lims_app` with the claims `identityAuthTx` sets, inside a rolled-back transaction, and proved 0 rows left. `import_breached_passwords` was also registered `per_tenant` although its handler calls `platformOnly` and rejects any tenant, so it could never run.
Night12's fix: an optional `taskScopes?: Record<string, 'per_tenant'|'platform'>` in `WorkerManifest` (`core/manifest.ts`, validated: id must be a declared task, scope valid, no contradiction with a crontab scope); `tasklist.ts` uses `mf.taskScopes?.[id] ?? c?.tenantScope ?? 'per_tenant'`; `jobs/identity/index.ts` sets `send_recovery` and `import_breached_passwords` to `platform`; four unit tests in `jobs/identity/__tests__/manifest.test.ts` (86 tests in the four focused identity files pass). `registry-sync` updates existing rows (`ON CONFLICT DO UPDATE SET scope = EXCLUDED.scope`): platform 8 to 10, per_tenant 181 to 179.
Proposed change: take the manifest change and the tests; review every module's tasks that are enqueued without tenant claims (night12 only traced inline payloads).
Backward compatible? yes (the default is unchanged).

### 2. Tasks that carry both tenant and tenantless payloads cannot have one scope  (To: C2 identity) (reported)
Problem: `identity.gotrue_signout` (`auth.service.ts:175` platform-user MFA/policy refusals; `session.service.ts:110`; `verifyMfaChallenge.ts:148`; `platform-staff.service.ts:237,271`, versus tenant payloads from `user`, `self`, `tenant-access`, `tenant.service`, `setPasswordFromSetup.ts:93`), `identity.send_invitation` (`platform-staff.service.ts:198`, payload `{invitation_id}`, no tenant, versus `user.service.ts:320` and `tenant.service.ts:389`) and `identity.remove_mfa_factors` (`platform-staff.service.ts:252` versus `user.service.ts:559`) are enqueued from both kinds of context. All three are `per_tenant` in the registry, so the platform callers hit the same `job_tenant_mismatch` as item 1. Night12 left them unchanged because no single scope serves both. In addition, the worker's platform branch of `send_invitation` and `remove_mfa_factors` is `platformUnwired` and fails closed, so platform-staff invitation mails fail regardless of templates.
Proposed change: split each into two identifiers (for example `identity.send_invitation` and `identity.send_platform_invitation`) with their own scope, or let `enqueue_job` take the scope from the caller's context; wire the platform branches.
Backward compatible? yes with new identifiers; a payload-based rule would change `enqueue_job` semantics (owner decision).

### 3. `identity.notify_ip_throttle` is enqueued but has no task and no registry row  (To: C2 identity) (reported)
Problem: `auth.service.ts:166` enqueues it on the tenantless login-failure path when an IP is throttled. There is no worker task and no `core.g_task_registry` row (a known gap in `async-manifests.test.ts`, LD-189), so that enqueue raises `unknown_task_identifier` exactly when an IP gets throttled, turning a throttled login into a 500.
Proposed change: implement the task and register it as `platform`, or drop the enqueue.
Backward compatible? yes.

### 4. `reporting.send_delivery` payload has no `tenant_id`  (To: C6 reporting) (reported, not proven live)
Problem: `reporting/service/delivery.service.ts:64` enqueues `{delivery_id}` inside a request transaction that has tenant claims, but without `tenant_id` in the payload. `enqueue_job` requires `payload.tenant_id` to equal the current tenant for a `per_tenant` task, and `taskRun` also needs it, so the enqueue fails for a missing key.
Proposed change: add `tenant_id` to the payload.
Backward compatible? yes.

### 5. Why the tests did not catch items 1 to 4  (To: C0-0B / C0-0D) (reported)
Problem: the identity integration tests (`recovery.integration.test.ts`) use a fake queue store, so the real `app.enqueue_job` scope rule is never exercised for tenantless callers. `async-manifests.test.ts` lists known gaps instead of failing.
Proposed change: add a test against the real function (a DB test in the devstack: enqueue each identity task from a tenantless transaction and from a tenant transaction) and make the known-gap list fail the build when an enqueued identifier has no registry row or the wrong scope.
Backward compatible? yes.

### 6. The worker had no GoTrue wiring and is not on `auth_net`  (To: C1, C2 identity; TRD owner) (static test verified, behaviour reported)
Problem: the identity worker tasks (`send_recovery`, `send_invitation`, `gotrue_signout`, `remove_mfa_factors`) call `gotrueGatewayFromEnv()` at run time. In `compose.app.yml` only api and web services are attached to `auth_net` (lines 136 and 155 of the file), the worker env has no `LIMS_IDENTITY_GOTRUE_URL`, `LIMS_IDENTITY_GOTRUE_SERVICE_KEY` or `LIMS_IDENTITY_GOTRUE_PUBLISHABLE_KEY`, and `infra/tests/static/test_t14_runtime.py:418` asserts workers are NOT on `auth_net` (02-TRD s7.4). On the host, after item 1 was fixed, the first real job failed four times with `common.dependency_unavailable`: the three variables were unset, TCP to 172.30.30.2:9999 timed out, and `supabase-auth` resolved to its `db_net` address that nftables drops (the trap from CR-005 item 2). So none of the identity GoTrue worker tasks could work on this host.
Night12's change (operator accepted it on 2026-11-21): worker-a/b on `auth_net` at fixed addresses (172.30.30.13/.14), `LIMS_IDENTITY_GOTRUE_URL`, `extra_hosts: supabase-auth:172.30.30.2`, and the service key and publishable key aliased to the existing `SERVICE_ROLE_KEY` and `ANON_KEY` ids for worker-a/b (as for the api); the static test now expects workers on `auth_net`. `auth_net` stays internal (nftables rule 7). It is reversible: revert three files, re-render, recreate worker-a.
Proposed change: owners decide whether the worker may join `auth_net` with the service-role key (the alternative is moving the GoTrue calls behind an api endpoint the worker calls); update TRD s7.4 and the static test to match the decision.
Backward compatible? yes.
Tenant/security impact: the worker environment now holds the GoTrue service_role key (full admin on GoTrue users). Scope: worker-a/b only, tmpfs env files, no published port. No PHI fields.

### 6a. `GOTRUE_MAILER_TEMPLATES_*` are never set; the mail link points at a route the edge does not serve  (To: C1) (absence verified, behaviour reported)
Problem: `mapping.md:22` in the identity gotrue module says the invite and recovery mail templates must link `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite|recovery` using `GOTRUE_MAILER_TEMPLATES_INVITE` / `_RECOVERY`. Nothing in `infra/` sets them (verified: no `MAILER_TEMPLATES`, `MAILER_SUBJECTS` or `MAILER_OTP_EXP` match anywhere under `infra/`; the upstream compose only sets `GOTRUE_MAILER_URLPATHS_*`). GoTrue therefore used its built-in template, and the first real reset mail contained `https://api.lmis.imisaxis.com/auth/v1/verify?token=...&type=recovery&redirect_to=...`, which the public edge answers with 404 by design (the api origin exposes only the nine routes of `public-routes.yaml`).
Night13's fix: a new internal service `auth-templates` (container `supabase-auth-templates`, `nginx:1.30.6`, read-only, uid 101, all capabilities dropped, 64 MB, healthcheck, `auth_net` only at 172.30.30.3, no published port) serving two static files rendered by the `supabase_stack` role: `recovery.html` and `invite.html` (plain text and one button each, no images, no tracking, no `.ConfirmationURL`, no `.Token`), with `GOTRUE_MAILER_TEMPLATES_RECOVERY` / `_INVITE` pointing at `http://172.30.30.3:8080/...` (an address, to avoid the DNS trap) and `GOTRUE_MAILER_SUBJECTS_RECOVERY` / `_INVITE`. The pinned GoTrue (v2.197.0) fetches templates lazily at the first mail and appears to fall back silently to its built-in defaults on failure (the binary contains `defaultTemplateBodies` and a template cache worker; the failure behaviour is not proven). A bad template URL is therefore invisible until the first mail; the only symptom is the default link again.
Proposed change: ship the templates and the template service in the supabase override and role (take the night13 files); add a deploy check that sends a recovery for a seeded test user to a mail sink (Mailpit is already used in non-prod) and asserts the link starts with `<SITE_URL>/auth/confirm?token_hash=` and ends with `&type=recovery`; pin nginx by digest.
Backward compatible? yes.

### 7. `GOTRUE_MAILER_OTP_EXP` was never set  (To: C1) (absence verified, default reported)
Problem: `mapping.md` requires `GOTRUE_MAILER_OTP_EXP=3600` (link lifetime at most 60 minutes, D-219) and the confirm landing says the link is valid for an hour. Nothing under `infra/` sets it (verified), so GoTrue used its built-in default (reported as 24 hours; not verified in the binary). Reset and invite links therefore lived far longer than the design says. Night13 set `MAILER_OTP_EXP=3600` in the role (`GOTRUE_MAILER_OTP_EXP`).
Proposed change: set it in the role and assert it in the preflight; add it to the GoTrue config checklist.
Backward compatible? yes (stricter).
Tenant/security impact: shortens the lifetime of one-time recovery and invitation links.

### 8. nginx is pinned by tag, not by digest  (To: C1) (reported)
Problem: `edge_nginx_image` and `monitoring_images.ops_nginx` use the tag `nginx:1.30.6`, not an `@sha256:` reference; the new template service reuses the same tag because it is the image present on the host. The repo's image rule elsewhere is digest pins.
Proposed change: pin nginx by digest (lock file, mirror into the registry) and use the same reference for the edge, ops-nginx and the template service.
Backward compatible? yes.

Tenant/security impact: items 1 and 2 decide who can enqueue which job; item 6 widens the worker's network and key access (accepted by the operator, to be confirmed by owners); item 7 shortens link lifetimes. No secret value appears in this CR. No new public surface.
IRD/regulatory impact: none.
Alternatives considered: keeping each fix only in the deploy copy on the host (done for the first deploy; not repeatable for a rebuild or DR).
Tests that will prove it:
- DB/devstack: for every identity task, an enqueue from a tenantless transaction and from a tenant transaction succeeds or fails exactly as its registry scope says; a task without a registry row fails the build (items 1 to 5);
- worker: `taskScopes` tests (night12's four) plus a platform-task run from a payload without `tenant_id` (item 1);
- compose static: the worker is on `auth_net` only if the TRD says so, and every identity variable a worker task reads is set (item 6);
- host smoke: `POST /v1/identity/auth/password/recover` for a seeded user returns 202 and the mail captured by the sink has the confirm-page link shape and the one-hour wording; `GET /health` of the template service answers from inside `supabase-auth` (item 6a, 7);
- preflight: `GOTRUE_MAILER_OTP_EXP` is 3600, templates are set, nginx references are digests (items 7, 8).

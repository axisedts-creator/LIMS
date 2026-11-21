Title: CR-C1-DEPLOY-009: the web app never learns the client address behind the repo's own edge; spoofable address header; server errors consume the login rate limit; weak first password accepted
From chunk: C1 (deploy attempt, prod-lean, 2026-11-21; found in a real browser sign-in through the test edge)    To owner: per item (listed below)
Type: bug
Blocking? yes for production go-live (the platform administrator cannot sign in: the api sees the web container as the client; every user shares one client address); no for any current orchestra task, so this file is named `.nonblocking`.
Relation to earlier CRs: 005 item 4 (platform CIDR list; empty means no restriction) and 006 item 7 (client address behind Docker); 007 item 2 (tenantless `gotrue_signout`, which turns a refused platform login into a 500); 008 (session ended by the password change). Fixes exist in the deploy copy on the host and in `DEPLOY-AXIS-NIGHT14.patch` (held by the deployer, not in the repo). Evidence per item: (verified) = I checked it in the repo; (reported) = taken from the host logs, the night report and the operator's screenshot, not re-run by me.

## Evidence from the host (reported)
- Before the fix, the api recorded the operator's browser requests from 172.30.20.11, the `web-a` container on `app_net` (`identity.auth_events.client_ip` for `password_reset_requested`, `recovery_link_opened`, `password_reset_completed`); it is outside the platform list `10.77.0.0/24,127.0.0.1/32,::1/128`.
- 07:37 UTC: five `loginStaff` requests returned 500 `common.internal` (each with a db error SQLSTATE P0001; rolled-back probe: `job_tenant_mismatch`), while GoTrue returned 200 on `/token` each time (the password was correct).
- After the edge fix (graceful nginx reload only), the operator's next request was recorded as `login_rate_limited` with client address 127.0.0.1 (the real tunnel client), and `loginStaff` returned 429 `common.rate_limited`; the screenshot shows "Too many attempts. Try again in 11 minutes."
- A fake login through `web-a` with `x-forwarded-for: 127.0.0.1` and the BFF key returned 401 and was recorded with 127.0.0.1, so the api trusts the forwarded address from a BFF-keyed request.

## Items

### 1. The repo's edge never sends the address the web app reads  (To: C1 edge, C2 web) (verified)
Problem: `infra/edge/nginx/snippets/proxy.conf` sets `X-Forwarded-For $remote_addr` (line 6) but no `X-Real-IP`. `apps/web/src/core/api/client-context.ts:27-31` reads the client address only from `x-vercel-forwarded-for`, else `x-real-ip`, and never from the incoming `x-forwarded-for`; it then sends the api `x-forwarded-for` (line 39) next to the BFF key (`server-fetch.ts:33`, `core/auth/client-ip.ts`). Behind the repo's own nginx edge the web therefore forwards no client address and the api uses the web container's address. Effects: the platform-admin CIDR check (`auth.service.ts:247-251`) refuses every platform login; per-IP login limits become one global limit; audit events and the IP-throttle logic carry the wrong address.
Night14's fix: `proxy_set_header X-Real-IP $lims_client_ip;` in `proxy.conf` (`$lims_client_ip` = `$remote_addr`, or 127.0.0.1 for the bridge gateway on a loopback-only edge: see 006 item 7), plus a new `snippets/clientip.conf` holding the repo default of that map.
Proposed change: take the edge change; decide whether the web should also accept the edge's `x-forwarded-for` (single trusted hop) so that no edge-specific header is needed.
Backward compatible? yes.

### 2. `X-Vercel-Forwarded-For` is trusted first and is not cleared by the edge  (To: C1 edge, C2 web) (verified, security)
Problem: `client-context.ts:27-31` prefers `x-vercel-forwarded-for` and calls it "set by the edge, not client-suppliable", which holds only on Vercel. `proxy.conf` (lines 4-12) clears `X-Request-Id`, `X-Forwarded-Host` and `X-Lims-Bff-Key` but not `X-Vercel-Forwarded-For`. On the nginx edge a client could send that header and choose its own address: it could pick an address inside the platform allow-list, or reset its own rate-limit key.
Night14's fix: `proxy_set_header X-Vercel-Forwarded-For "";` at the edge.
Proposed change: clear it at the edge, and make the web read `x-vercel-forwarded-for` only when an explicit setting says the host is Vercel.
Backward compatible? yes.
Tenant/security impact: closes a way to bypass the platform-admin address restriction and per-IP limits. No PHI fields.

### 3. A server error consumes the login rate limit  (To: C2 identity) (reported)
Problem: the five 500 responses of `loginStaff` (item 4 below) each used up part of the account's login quota, so the operator, whose password was correct, was locked out ("Too many attempts. Try again in 11 minutes.") on the first try after the fix. The recovery handler shows the same ordering (`requestPasswordRecovery.ts:47` calls `consumeAttempt` before the work).
Proposed change: do not count an attempt that ends in a server error (or refund it), and count only failed credentials; document the thresholds and window in the operator notes so a lockout is understandable.
Backward compatible? yes.

### 4. A refused platform login is a 500, not a 403  (To: C2 identity) (verified chain; effect reported)
Problem: `auth.service.ts:247-251` (`platformLogin`) calls `signOut('login_blocked_ip')` before returning `identity.platform_ip_denied`; `signOut` enqueues `identity.gotrue_signout` with `{user_id}` and no tenant (`:175-176`), which is registered `per_tenant`, so `app.enqueue_job` raises `job_tenant_mismatch` and the response is 500. This is CR-007 item 2; it stays open, and it is why the wrong client address in item 1 showed up as a 500.
Proposed change: as in CR-007 item 2 (split the task or give it a platform identifier).

### 5. A very weak first password was accepted  (To: C2 identity, C1) (reported)
Problem: the first platform administrator set a 17-character password made of a common digit run and a keyboard sequence, and `setPasswordFromSetup` accepted it. The policy (`password-policy.ts`: 12 code points, at most 72 bytes, local breached list) can only reject what is in the breached list, and `identity.import_breached_passwords` was never run on the host (it needs `LIMS_IDENTITY_BREACHED_LIST_PATH` at run time, which is unset; CR-007 item 1 made the task runnable). The operator also showed the password in a screenshot, so it must be treated as exposed.
Proposed change: in production, fail closed when no breached list is loaded (refuse to set a password, or log an alert), ship or import a list as a deploy step, and add a check to `DAY-0.md` before the first password.
Backward compatible? stricter in production.
Tenant/security impact: raises the floor for every first password; no PHI fields.

### 6. Edge playbook and test gaps found while applying the fix  (To: C1) (reported)
- Night11's edge playbook needs `-e @stage3-vars.yml`; run without it, the role rendered the inventory placeholder names and created placeholder certificate directories (`/srv/lims/edge/certs/{staff,portal,api}.placeholder.invalid`), and the live edge served those names for about 30 seconds. Night14's reload playbook asserts `origins.staff_web` and the container's existence, and skips container and certificate steps. Proposed: make the role refuse placeholder origins in production.
- `infra/tests/static/test_t13_edge.py` was broken by night11's `$lims_client_ip` change (6 failures and 22 errors before night14's edits, 77 of 78 pass after); one unrelated failure remains: `GenRoutesTest.test_committed_yaml_equals_generator_output` ("contracts/openapi/billing.yaml: found duplicate anchor 'a1'").
- The portal forwards the incoming `x-forwarded-for` as the edge wrote it (reported), so it needs no change with this edge.

Tenant/security impact: items 1 and 2 decide which client address the api trusts for the platform-admin range and for rate limits; item 5 concerns first passwords. No secret value appears in this CR (the password itself is not written here).
IRD/regulatory impact: none.
Alternatives considered: widening the platform CIDR list to the web container's network (rejected: it would admit every request through the web app); keeping fixes only in the deploy copy (not repeatable for a rebuild).
Tests that will prove it:
- static (edge): `proxy.conf` sets `X-Real-IP` and clears `X-Vercel-Forwarded-For`; rendered nginx config passes `nginx -t`;
- web: unit tests for `readClientContext` with and without the Vercel setting;
- host smoke: a request through the edge from a known client address is recorded in `identity.auth_events.client_ip` as that address; a request with a client-supplied `X-Vercel-Forwarded-For` or `X-Real-IP` is recorded with the real address;
- identity: a login that ends in a server error does not reduce the remaining attempts; a refused platform login returns 403 `identity.platform_ip_denied`;
- password: with no breached list loaded in production, setting a first password is refused or alerts.

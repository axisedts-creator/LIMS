APPROVE

Reviewed `git diff d07a7056..HEAD` (T6 tests bdacfb59 + impl 8d921764) against 03-APP-FLOW §3.1/§3.3, 01-PRD AC-A1.1–A1.7 (+A1.6a/b), 07-SECURITY AU-T1/T2b/T10/T14/T19/T22/T23, 05-SCHEMA §4.3/§5/§6 (auth_events DDL + type CHECK, sessions DDL, identity_login_context, identity_record_auth_event), 02-TRD env table + §6 task table, C0 core/db/tx.ts, core/ratelimit.

Verified
- Names verbatim: all 10 event types are in auth_events__type__ck; error codes auth.login_failed / auth.step_up_required / auth.account_locked / identity.membership_inactive / identity.tenant_suspended / identity.platform_ip_denied / common.rate_limited / common.validation_failed / common.dependency_unavailable; tasks identity.notify_ip_throttle (payload {client_ip, window_start} = args of app.identity_notify_ip_throttle_hmacs) and identity.gotrue_signout (platform payload {user_id} only, key signout:<user_id>:<reason>); env names match 02-TRD.
- Tenant isolation: one ctx.db.identityAuthTx (loginStaff is in C0 IDENTITY_AUTH_OPS); tenant only from app.identity_login_context; bindTenant once, before any tenant write; tenant-less events only via the DEFINER (repo refuses tenant_id); platform writes only via identity_platform_auth_write_*; INSERT columns match the sessions / auth_events DDL; SQL is parameterised only. No new tables/policies in this task (no RLS DDL to check).
- P-42: C0 attempt() COMMITs when fn returns, so returning the error out of the callback and re-throwing keeps exactly the event/job writes; a throw without commitOnError rolls back. ctl.noRetry() set. D-202: no idempotency use.
- Client IP only ctx.clientIp (P-61); a: key through ctx.rateLimit.consume('login'); 400 ms floor on all failure exits; flow order IP throttle -> 10/h cap -> backoff/step-up -> GoTrue matches §3.1/§3.3; GoTrue 5xx/network -> dependency_unavailable, not counted.
- No PHI/password/e-mail in logs or events (HMAC only); no secrets in files; only C2-owned paths touched (+ .orchestra notes/cr).
- Tests: T6-verify run by reviewer: 3 files, 109/109 pass. done_when items covered (rate-limit fake, P-42 scenarios, D-202, timing p95, forged body, A6.6/A8.1 at service level; pgTAP 19/20/32 pre-existing).

Non-blocking (already in .orchestra/cr/C2.T6.nonblocking.md, owner decision)
- f:<ip> and account failure windows are process-local Maps (C0 has no f: rule / non-consuming read): N instances = N x thresholds. C0 ratelimit comment assigns f: to C2, but 03-APP-FLOW §3.3 puts state in the C0 store.
- 200 body omits SessionState.actor (no source in login_context); with responseValidation on, openapi.ts turns the 200 into 500 common.internal until the CR lands.
- C0 wrap() HandlerContext does not yet pass db/actor/requestId/bffKey/rateLimit/commitOnError (module-wide C0 gap); loginStaff fails closed (common.internal / wrong_bff 401) until it does.
- Password-ok with no membership / multi-membership: 401 without an identity.gotrue_signout job (flow does not require one; GoTrue session is orphaned, tokens never leave the API).
- core.users.last_login_at not written (05-SCHEMA §5 table lists it; §3.1 flow names only memberships.last_login_at).

# T0D-ELABMENU-2 impl (writer)
Files: services/api/src/core/pipeline/index.ts (buildCtx sets ctx.sessionId = verified claims.lims_session_id, UUID only, for a non-platform tenant user/partner session; key absent otherwise; never from the request); apps/web/src/app/(staff)/admin/me/page.tsx + features/admin/components/MyAccount.tsx (failed sessions/factors reads passed as ReadFail, shown as "Could not load ..." + reference, auth.step_up_required shows a "Verify with two-step" link to /auth/mfa; "Set up" hidden on a failed factors read).
[CONV] fix lives in core pipeline (tester root cause; outside the brief's file list but no route/permission/contract change, 3 files). Self handlers and security rules unchanged: missing/invalid claim still 401.
Ran: verify.cmd set + all of src/core/pipeline: api 1137 pass; web elabmenu2 13/13 pass; api tsc clean; web tsc: no errors in changed source (pre-existing test-file errors only).
src/modules/identity: 6423 pass, 2 fail pre-existing and unrelated (ci-scripts service-key grep flags core/health.ts; role-packs route-guard regex on AppShell.tsx).
Open: live staging check of /admin/me after deploy.

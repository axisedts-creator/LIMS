APPROVE
T0D-ELABMENU-2 review (reviewer, 2026-11-17). Diff 022c859f7..HEAD, 10 files (within the 12-file cap).
- Root cause correct: bindSelf (identity/handlers/self.http.ts:27) needs ctx.sessionId; buildCtx set only platformSessionId, so getMe/listOwnSessions/listOwnMfaFactors always threw auth.unauthenticated while listRoles (bindRole) needs no session id.
- Fix (core/pipeline/index.ts:141-152): sessionId only from verified claims.lims_session_id (resolver.ts:120-121 issues it for user/partner), UUID-checked, tenant user/partner only; platform/device/patient/no-tenant get no key; never read from the request. No security rule lowered: missing/invalid claim still 401; expiry/revocation path unchanged (same as listRoles).
- Web: failed reads are no longer swallowed to [] ("Could not load ..." + reference); auth.step_up_required shows link to /auth/mfa; "Set up" hidden on failed factor read. No route, permission, contract or error-code change; no PHI/secrets; no RLS surface touched.
- Pipeline core is outside the brief's file list; flagged [CONV] by tester and writer (3 files, no contract change) — acceptable under LD-310, lead to note.
- Tests: re-ran api src/core/pipeline + self.pipeline.test.ts: 1137 pass / 24 skipped; web elabmenu2 config: 13/13 pass. Tests cover fixed path, refusals (no claim, request-supplied id ignored, device/no-tenant), service refusals, and web failure/step-up display.
- Not verified: live staging /admin/me after deploy; HandlerContext (core/module.ts) does not declare sessionId (handler casts; pre-existing, not a defect).

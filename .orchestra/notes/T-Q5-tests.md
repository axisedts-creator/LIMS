# T-Q5 tests (tester)
- apps/web/src/features/engagement/__tests__/t-q5.board-route.test.ts — BFF GET /queue-display/api/board: no cookie 401, token header only, ETag/304, revoked 401, 5xx no token leak, GET-only.
- apps/web/src/features/engagement/__tests__/t-q5.source.test.ts — (display) layout no shell/session, 4 states + texts, kit QueueBoard, 5 s poll, cookie attrs (name/HttpOnly/Secure/Strict/Path/Max-Age/no Domain), no PHI.
- apps/web/tests/e2e/engagement/T-Q5.queue-display.spec.ts (+playwright.config.ts) — compose e2e pair→revoke; NOT in verify (needs stack + LIMS_E2E_* env; skips if unset).
- Assumes: board route at queue-display/api/board/route.ts (TRD tree); cookie set by a file under (display)/queue-display/**.
- Run: .orchestra\notes\T-Q5-verify.cmd. Expected now: all fail (implementation files missing).

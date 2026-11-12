# T-Q5 impl (writer)
- Files (all under apps/web/src/app/(display)/): layout.tsx, queue-display/{page.tsx,QueueDisplay.tsx,pairing.ts,api/board/route.ts}.
- [CONV] pairing.ts exports setDisplayCookie(token) (HttpOnly; Secure; SameSite=Strict; Path=/queue-display; Max-Age 31536000; no Domain) and readDisplayToken (43-char base64url check).
- [CONV] Route: GET only; 401 for no/invalid cookie or upstream 401; 304 relayed; other upstream failures -> 5xx common.internal; token never echoed.
- [CONV] Page: no cookie -> "Not paired" text; 401 while polling -> "This screen is no longer paired" and polling stops; 3 failed polls -> stale banner, board kept; sound off (soundEnabled=false).
- Tests: `vitest run src/features/engagement/__tests__/t-q5` -> 2 files, 18 passed. e2e not run (needs compose stack).
- OPEN: `@lims/ui/components/QueueBoard` does not exist yet (CR-C16-016, C0-0D) -> `tsc` fails with TS2307 in QueueDisplay.tsx until the kit ships it; props follow 04-UI-UX §9.2.
- Review round: item 1 = test-only (tester done); item 2 = T-Q4 scope, no T-Q5 file change; board already renders token_label via QueueBoard nowCalling. Re-run: 18/18 passed (15.5 s). vitest testTimeout bump = config outside ownership.
- OPEN: nothing calls setDisplayCookie yet — the staff W7 "Pair this screen" action (T-Q4 files, outside T-Q5 ownership) must call Q8 then setDisplayCookie.

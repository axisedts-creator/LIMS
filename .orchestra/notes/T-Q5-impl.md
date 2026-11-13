# T-Q5 impl (writer)
- Files: (display)/layout.tsx, queue-display/{page.tsx,QueueDisplay.tsx,pairing.ts,api/board/route.ts}; LD-145: packages/ui/src/components/QueueBoard/{QueueBoard.tsx,QueueBoard.stories.tsx}. QueueDisplay now types generated_at/staleSince as IsoUtc (re-exported by QueueBoard) and passes staleSince only when stale (exactOptionalPropertyTypes).
- [CONV] pairing.ts: setDisplayCookie (HttpOnly; Secure; SameSite=Strict; Path=/queue-display; Max-Age 31536000; no Domain); route GET only, 401/304/5xx, token never echoed.
- [CONV] QueueBoard: token size max(4 x 2xl token = 96 px, 12vh) in a class; clock in tenant zone Asia/Kathmandu with seconds; isNew row gets data-new="true" + flash class for 3 s; chime = Web Audio sine 880 Hz 0.4 s only when soundEnabled; unpaired reuses "Not paired" / "Ask a lab administrator to pair this screen".
- Tests: web t-q5 18/18 pass; queueboard 9/10 — 1 failing test disputed (T-Q5-dispute.md: UTC assumption vs tenant zone). tsc: packages/ui 0 errors; apps/web 0 errors in (display) (170 pre-existing in other chunks' test files). e2e not run (needs compose).
- OPEN: stale banner now renders twice (page's own banner + kit banner); the source test requires the "Connection lost" text in (display) source, so the page banner stays until the tester/reviewer decides.
- OPEN: W7 "Pair this screen" (T-Q4) must call Q8 then setDisplayCookie.

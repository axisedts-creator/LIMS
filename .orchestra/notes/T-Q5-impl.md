# T-Q5 impl (writer)
- Files: (display)/layout.tsx, queue-display/{page.tsx,QueueDisplay.tsx,pairing.ts,api/board/route.ts}; LD-145: packages/ui/src/components/QueueBoard/{QueueBoard.tsx,QueueBoard.stories.tsx}. QueueDisplay now types generated_at/staleSince as IsoUtc (re-exported by QueueBoard) and passes staleSince only when stale (exactOptionalPropertyTypes).
- [CONV] pairing.ts: setDisplayCookie (HttpOnly; Secure; SameSite=Strict; Path=/queue-display; Max-Age 31536000; no Domain); route GET only, 401/304/5xx, token never echoed.
- [CONV] QueueBoard: token size max(4 x 2xl token = 96 px, 12vh) in a class; clock in tenant zone Asia/Kathmandu with seconds; isNew row gets data-new="true" + flash class for 3 s; chime = Web Audio sine 880 Hz 0.4 s only when soundEnabled; unpaired reuses "Not paired" / "Ask a lab administrator to pair this screen".
- Tests (after ruling 4dc7e4ce, no code change): web t-q5 18/18 pass; queueboard 10/10 pass. tsc: packages/ui 0 errors; apps/web 0 errors in (display) (pre-existing errors in other chunks' test files). e2e not run (needs compose).
- Review round 3: page stale banner + hhmm removed from QueueDisplay.tsx; kit QueueBoard owns it (LD-145). web t-q5 19/19, queueboard 10/10, tsc 0 errors in (display).
- OPEN: W7 "Pair this screen" (T-Q4) must call Q8 then setDisplayCookie.


## Debug (verify timeout)
Cause: jsdom+dompurify lazy-loaded on first sanitise (~2.3 s cold); first N9 test (first sanitise call) exceeded 5 s vitest timeout under load.
Fix: sanitise.ts calls deps() at module import so cold load moves to beforeAll import (10 s hook limit), not a request.
Result: verify.cmd 235/235 pass. No test edited.

## Debug round 2 (verify: Cannot find module 'dompurify')
Cause: dompurify/jsdom absent from services/api/package.json (+ lockfile, not installed). Not an impl-code bug; C0-0D owns package.json (01-CHUNK-MAP §3), CR-C6-019 ACCEPT, request open in .orchestra/cr/C6-T17.md.
Fix: none made. Editing package.json would break ownership rule; code/tests untouched. Needs C0-0D to add dompurify 3.4.17 + jsdom 31.0.0 and regenerate lock, then re-run verify.cmd.
(Round-1 timeout note above is superseded; its deps() eager-load fix remains in sanitise.ts.)

## Debug round 3 (same verify failure)
Cause unchanged: dompurify/jsdom not in services/api/package.json (C0-0D owns it, 01-CHUNK-MAP l.122). CR .orchestra/cr/C6-T17.md still open.
Fix: none. Impl code correct; editing package.json breaks ownership. Needs C0-0D add dompurify 3.4.17 + jsdom 31.0.0, regen lock, pnpm install, re-run verify.

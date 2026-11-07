
## Debug (verify timeout)
Cause: jsdom+dompurify lazy-loaded on first sanitise (~2.3 s cold); first N9 test (first sanitise call) exceeded 5 s vitest timeout under load.
Fix: sanitise.ts calls deps() at module import so cold load moves to beforeAll import (10 s hook limit), not a request.
Result: verify.cmd 235/235 pass. No test edited.

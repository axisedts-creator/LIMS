APPROVE

Round 2. Item 1 fixed: the e2e (T-Q5.queue-display.spec.ts:524-529) now issues a token with Q4 (Idempotency-Key) and calls Q5 `call-next` with `counter_id`, then checks that `token_label` shows within 10 s before it revokes. The routes and bodies match 02-TRD §Q4/Q5/Q8.
Item 2 is closed for T-Q5 and moves to the orchestrator. 03-APP-FLOW:432-435 puts the Q8 call and Set-Cookie in the W7 "Pair this screen" BFF action, and T-Q4 owns W7 (`(staff)/engagement/queue/**`, `features/engagement/server/queue*`). T-Q5 supplies `setDisplayCookie` with the attributes from 02-TRD:373. Orchestrator: reopen T-Q4 so W7 calls Q8 → `setDisplayCookie(display_token)` → redirect `/queue-display`. After that, switch this e2e from `context.addCookies` to the W7 flow.

Checked OK (unchanged since round 1): cookie name and attributes match the spec exactly; the board route sends only `X-Lims-Display-Token`, never a bearer, and never echoes the token; ETag/304 relay with no-store; the layout has no shell or session; state texts match the spec; no PHI, no secrets, only owned paths. This task has no DB/RLS work.
Non-blocking: playwright.config.ts:2-3 comment does not list LIMS_E2E_COUNTER_ID. Cold-load vitest timeout flake (T-Q5-debug.md): raise testTimeout in the vitest config. The e2e still needs a compose run. tsc stays red until the kit ships QueueBoard (CR-C16-016).


LEAD ADDENDUM 2026-11-13: the kit component QueueBoard that QueueDisplay.tsx imports does not exist in packages/ui, so T-Q5 does not build for real even though its source tests pass. LD-145 authorises exactly this: WRITER creates QueueBoard (props and behaviour in LD-145), TESTER adds its render test. Nothing else changes; then rerun the T-Q5 verify and tsc.

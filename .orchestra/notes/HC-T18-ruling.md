TESTS_WRONG — the 20 s per-test budget is a test-harness choice, not a spec requirement; no assertion failed.
Reasons:
1. spec/chunks/C17-home-collection/06-IMPLEMENTATION-PLAN.md:41 (HC-T18 row) requires "component tests; axe; keyboard-only walk-through" and US-03/04/05 behaviour. It sets no time budget for typing into or rendering a dialog.
2. A grep of spec/ for testTimeout, keystroke, input-latency and INP budgets finds nothing for C17 web. The only keystroke rule is in C4 (spec/chunks/C4-frontdesk-billing/01-PRD.md:158), and it counts keystroke groups, not milliseconds.
3. Dispute evidence (.orchestra/notes/HC-T18-dispute.md:2-3): every failure is `Test timed out in 20000ms`, the failure count changes from run to run, and the same test passes with a larger timeout. That is machine-load flakiness in the harness, not wrong behaviour.
4. The cause is tester-owned code: `fill` at __tests__/hc-t18.helpers.tsx:43 calls the default `userEvent.type`, which waits on a timer for every character. The 20000 ms cap is at __tests__/vitest.hc-t18.config.ts:15.
Required test changes (keep every assertion and every keyboard path):
a. helpers.tsx: create one `const user = userEvent.setup({ delay: null })` and use it in `fill` and `pick`. For long free-text values (more than 20 characters), `fill` may use `user.click(el); user.paste(v)` instead of typing.
b. vitest.hc-t18.config.ts: raise `testTimeout` to 120000 and set `hookTimeout` to 120000 so slow imports on a loaded machine do not cause false failures.
c. The keyboard-only walk-through tests must still type at least one field character by character with `user.keyboard`/`user.type`, so keyboard coverage is not lost.

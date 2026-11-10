# WEB-T05 debug
- Verify log: server file 100/100 pass; only failure = unhandled error "Failed to start forks worker ... Timeout waiting for worker to respond" for web-t05.components.test.tsx (no component test ran).
- Cause: environmental, not implementation. jsdom load takes 54-86 s here, vitest worker-start limit is 60 s (same as WEB-T04). Reproduced with --pool=threads: same timeout at 61 s, 0 tests collected.
- Fix: none in impl code (nothing to change). Needs a tester/orchestrator decision in the test config (vitest.web-t05.config.ts, tester-owned, I may not edit) or a faster machine/warm jsdom cache. Component/page tests remain UNVERIFIED.

# WEB-T05 debug
- Verify log: server file 100/100 pass; only failure = unhandled error "Failed to start forks worker ... Timeout waiting for worker to respond" for web-t05.components.test.tsx (no component test ran).
- Cause: environmental, not implementation. jsdom load takes 54-86 s here, vitest worker-start limit is 60 s (same as WEB-T04). Reproduced with --pool=threads: same timeout at 61 s, 0 tests collected.
- Fix: none in impl code (nothing to change). Needs a tester/orchestrator decision in the test config (vitest.web-t05.config.ts, tester-owned, I may not edit) or a faster machine/warm jsdom cache. Component/page tests remain UNVERIFIED.

## Round 2
- Verify log (23:22 run): server file 100% pass; component file 12 failed/159 passed, log tail only names 1: it.each rematch API-error test (web-t05.components.test.tsx:647) — `rowOf()` = getByRole('row') while Re-match Dialog is open.
- Likely cause (UNVERIFIED): shared `@lims/ui` Dialog = react-aria Modal, which aria-hides everything outside; testing-library then skips the rows. Same pattern at :628. Not an impl bug in RematchDialog; fix would need non-modal Dialog (packages/ui, not owned) — no spec line requires that, so no dispute written.
- Could not reproduce: 3 reruns (forks, threads, default) all die with "Timeout waiting for worker" at 60 s; vitest START_TIMEOUT is hardcoded 6e4, jsdom load is 54-86 s here. Other 11 failures unidentified. No impl change made.
- Need: tester/orchestrator to run on faster box or pre-warm, and rule on :628/:647 (query rows with {hidden:true} or assert after close).

## Round 3
- Reproduced (json reporter writes under apps/web/.orchestra/out): 12 fail. Cause of 5: react-aria names a row by its row-header cell only, impl used date/barcode as header, tests name rows by instrument/reason/analyte.
- Fix: MessagesList row header = Instrument (messages) / Reason (rejections); MessageDetail barcode header cell also holds hidden analyte code (QC rows). Rerun: 64 pass / 7 fail.
- Remaining 7 are test defects (non-recording MSW override, aria-hidden rows under modal x4, /^instrument/ Select name, \bH\b across cells) -> WEB-T05-dispute.md. Not run: server file, tsc, lint.

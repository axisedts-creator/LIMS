CHANGES
Round 3 (range 1c8fe8e4..2026e3da). Last writer commit changed notes only; code identical to round 2. Verify log 13:50: 3 files, 82/82 pass (TokenSlip stub aliased). `tsc --noEmit` in apps/web, engagement errors: TS2307 QueueConsole.tsx:12 plus 6 in tester file t-q4.setup.test.tsx. Round-2 items (Alt+C stopgap with CR, StatusChip tone+word in W6/W7) stay resolved. Owned paths only; no PHI, no secrets, no new names.

1. TESTER, real defect: tests do not typecheck, so the feature cannot pass the `tsc` gate even after TokenSlip lands.
   - apps/web/src/features/engagement/__tests__/t-q4.setup.test.tsx:22 `user.type(f, value, { delay: null })`: TS2353, `delay` is not a `type()` option. Fix: drop the third argument and create the user with `userEvent.setup({ delay: null })` where `fill` users are made (or leave the default delay).
   - t-q4.harness.tsx:70-72 mocks are `vi.fn(async () => {})`, so `mock.calls[0]![0]` is typed `[]` (TS2493 at setup.test.tsx:93, :142, :177, :218; TS2352 at :177). Fix: type each mock with an argument, e.g. `vi.fn(async (_body: unknown) => {})` for createQueue/updateQueue/createCounter/updateCounter/pairDisplay/revokeDisplay (and any other setupActions entry read through `mock.calls`). After that :177 no longer needs a cast via unknown.
   Done when `pnpm --dir apps/web exec tsc --noEmit` shows no t-q4.* errors and verify stays 82/82.
2. Blocker, not C16 code: QueueConsole.tsx:12 imports `@lims/ui/components/TokenSlip`, still missing in packages/ui (CR-C16-016 ACCEPTED, not shipped); TS2307, done_when "needs CR-C16-016" unmet. Fix: no C16 change. Lead holds T-Q4 until C0 ships TokenSlip; then remove the stub alias in __tests__/vitest.t-q4.config.ts and re-run verify plus tsc.
Non-blocking, for the lead (unchanged): kit StatusChip has no icon (LD-140 gap in C0); BFF poll route app/(staff)/engagement/queue/tokens/route.ts not in contracts/routes.yaml; server code has only source-level tests.


LEAD ADDENDUM 2026-11-13 (supersedes "Lead holds T-Q4 until C0 ships TokenSlip", item 2): LD-143 now authorises the WRITER to create TokenSlip in packages/ui (props from 04-UI-UX section 9.2) and the TESTER to add its render test. Item 1 (tester type errors) stands as written. Do both, then rerun the T-Q4 verify and tsc.

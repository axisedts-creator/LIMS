# CR WEB-BUILD-2 (non-blocking): test-file type errors remain under `pnpm typecheck`
- `pnpm --filter @lims/web build` is green (tests excluded via tsconfig.build.json). `tsc --noEmit -p apps/web` (tsconfig.json, unchanged) still reports 283 errors in 167 files (log: `.orchestra/notes/WEB-BUILD-2-tsc.log`).
- By folder, errors in `__tests__` files under `src/features`: admin 13, analytics 12, anatomic 18, billing 1, catalog 58, frontdesk 5, homecollection 7, instruments 45, inventory 19, lab 33, micro 24, partners 4, payments 6, platform 2, quality 10, reporting 2, smartreport 6 (= 265); `src/core/shell` 2.
- Remaining 16: some tests under `src/app/**/__tests__` (e.g. `engagement/enquiries/__tests__/t-n1.enquiries.test.tsx` TS2353 `onUnhandledRequest`) and apps/portal files pulled in through `features/reporting/__tests__/rs-c6.portal.test.tsx` (TS2307 `@/features/portal/*`, `@/server/*`).
- List them: `pnpm --filter @lims/web exec tsc --noEmit -p . | grep "error TS"` (add `| grep -E "__tests__|\.test\.tsx?"` for tests only).
- Founder decides who fixes them (not touched here).

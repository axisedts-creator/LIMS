# J-T03 debug
- Cause: writer's scanner change never landed (commit 5127a3ec = notes only); copy-scan.mjs still matched per line with single-space regexes, so wrapped / multi-space / tab / nbsp / JSX-wrapped phrases bypassed (4 tests failed).
- Fix: apps/web/src/features/billing/__tests__/copy-scan.mjs - BANNED uses `\s`/`[\s-]+`; match over whole file text (matchAll, 'gi'); line no = newlines before match + 1. Banned list unchanged (US-BL-16.1).
- Real repo scan: clean (99 files). Full test run: see verify.

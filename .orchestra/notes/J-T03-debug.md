# J-T03 debug
- Cause: writer's scanner change never landed (commit 5127a3ec = notes only); copy-scan.mjs still matched per line with single-space regexes, so wrapped / multi-space / tab / nbsp / JSX-wrapped phrases bypassed (4 tests failed).
- Fix: apps/web/src/features/billing/__tests__/copy-scan.mjs - BANNED uses `\s`/`[\s-]+`; match over whole file text (matchAll, 'gi'); line no = newlines before match + 1. Banned list unchanged (US-BL-16.1).
- Real repo scan: clean (99 files). Full test run: see verify.
- Round 2: the round-1 edit never reached the file (commit 9c821b3f = notes only); applied it now, plus fixed a literal-newline slip in the line-number split.

## Round 3 (debugger)
- Cause: copy-scan.mjs matched BANNED regexes per line with literal single spaces, so hard-wrapped, CRLF-wrapped, multi-space, tab and nbsp phrases bypassed it (4 bypass tests failed).
- Fix: scan whole file text with `\s+` between words (covers newline/tab/nbsp); line number computed from match index. File: apps/web/src/features/billing/__tests__/copy-scan.mjs.

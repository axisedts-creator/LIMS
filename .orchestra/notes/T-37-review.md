APPROVE

Re-review of `9198dd0d..f86c4220` (fixes in 36985bbc, f86c4220) against 02-TRD §12, AC-19.4 / AC-08.4, plan row T-37. I ran `vitest run --no-file-parallelism src/modules/catalog/__tests__/perf`: 4 files, 12/12 pass (17.8 s).

Prior items:
1. Fixed. `priceFor.perf.test.ts:53` now uses `budget = 20` at both 1x and 10x, matching §12. It passes with no source tuning and no loosened number. The `gc?.()` call does nothing unless node runs with `--expose-gc`, and the test passes without that flag.
2. Fixed. `.orchestra/cr/T-37.md` (CR-C3-037) covers the price-import 1k/20k validate/commit rows. It proposes adding the worker perf dir to T-37 `files` or deferring the rows explicitly.
3. Fixed. The same CR records the k6 compose-stack run (and the real-Postgres p95) as blocked on [PIN-C0].

Names, owned paths, tenant isolation, no PHI or secrets, nothing invented: OK. T-37 done_when stays partly open until CR-C3-037 is resolved. That is now tracked, not hidden.

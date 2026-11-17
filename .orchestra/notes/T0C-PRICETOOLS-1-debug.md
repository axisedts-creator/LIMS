
## Debugger round (verify failed: exit 1 with 791/791 tests green)
- Cause: vitest "[vitest-worker]: Timeout calling onTaskUpdate" (3 unhandled errors, fixed 60 s birpc timeout). `lintRepo` (async, but ~13-40 s of pure sync work, no macrotask turn) and the sync codegen check starve the worker, so RPC replies are not read. No product or test defect.
- Fix: tools/codegen/lint-openapi.ts `lintRepo` yields `setImmediate` before and after `lintOpenapi`. No test touched.
- Re-run: codegen 3 files 791/791, 0 errors (was 3, then 1 at lower load). services/api 3 files 26/26. db suite T0C-PRICETOOLS-1 ran, no failure printed (exit code not captured).

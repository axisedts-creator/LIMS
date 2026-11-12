# T0D-12d debug
- Cause: no implementation defect. In the failed verify run all 652 codegen tests passed, but vitest raised 2 "[vitest-worker] Timeout calling onTaskUpdate" unhandled errors (machine load, ~280s run) -> non-zero exit -> `&&` chain skipped the services/api leg.
- Fix: none needed (no code/test edit). Reran: services/api inventory-spec-load 3/3; tools/codegen 3 files 652/652, 0 errors (clean, 197s). contracts 30/30 passed in the failed run.
- If the timeout recurs, run the codegen leg with less parallel load (not a repo defect).

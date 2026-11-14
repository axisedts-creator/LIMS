APPROVE

# WIRE-CAT review (reviewer)
Diff 5c4c1b60..HEAD: catalog/index.ts (+ports), new manifest-ports.test.ts, notes. Only the brief's file + tester file touched (LD-185 scope).

- Rule 1: `ports: { CatalogPort }` = createCatalogPort({ cache: createCatalogCache({ maxEntries, ttlSeconds }) }) from loadCatalogConfig(process.env); module-level, so one process-wide instance. Same pattern as reporting/index.ts:24. Impl and cache untouched.
- Rule 2: construction is in-memory only; loadCatalogConfig defaults all keys (empty env OK); bad LIMS_CATALOG_* fails fast at import (TRD 10.1 boot failure, intended).
- Rule 3: registry untouched; tests show forced fake still works in dev/ci and is refused in production.
- Names verbatim (CatalogPort, LIMS_CATALOG_CACHE_*, LD-185 cited). No SQL/RLS, routes, PHI, logs or secrets in the diff.
- Tests: cover every done_when item (validateManifest, keys, 9 methods, shared instance, empty env, staging 'real', no socket/fetch).

Checks run:
- `vitest run src/modules/catalog`: 89 files, 5473 passed, 2 skipped.
- `vitest run src/__tests__ src/core`: 1 failed, 1441 passed. The failure is real-modules-boot.test.ts "Test timed out in 60000ms". It ALSO times out with catalog/index.ts reverted to the base commit, so WIRE-CAT did not cause it (the full module import takes too long on this Windows host). Not a WIRE-CAT defect. Lead/tester should look at it separately.
- Reviewer note: to get that baseline I temporarily replaced index.ts with the base version, then wrote the HEAD content back (git checkout was blocked). Check `git status` shows index.ts clean.

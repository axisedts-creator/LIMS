# WIRE-CAT tests (tester)
- File: services/api/src/modules/catalog/__tests__/manifest-ports.test.ts (15 tests). Run: `.orchestra/notes/WIRE-CAT-verify.cmd` (= `pnpm --dir services/api exec vitest run src/modules/catalog/__tests__/manifest-ports.test.ts`).
- Covers: validateManifest; ports keys == ['CatalogPort']; 9 methods; shared instance across imports; empty env; resolvePorts staging/dev/ci -> 'real'; forced fake still works in dev/ci, refused in production; staging without catalog still fails; cache built once from loadCatalogConfig (defaults 50000/600, env override); no socket/fetch.
- Now: 11 fail (`manifest.ports` undefined / resolution 'fake'), 4 pass (registry-not-weakened guards). Fails for the right reason.
- Brief says "existing catalog manifest.test.ts": none exists in services/api/src/modules/catalog; nothing to keep green there.
- Tests relying on the fake CatalogPort: none found in src/__tests__ or core (they inject their own ports). Full-suite run after the writer's change may reveal more; not run by me.
- Not tested: construction laziness (eager or lazy both accepted); real DB use of the port (covered by CatalogPort.*.test.ts).

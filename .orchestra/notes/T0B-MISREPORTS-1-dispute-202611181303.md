# T0B-MISREPORTS-1 dispute (writer, 2026-11-18 12:13 NPT)

TESTS_WRONG (environment timeout, not behaviour): services/api/src/modules/analytics/__tests__/boot.test.ts:246, the `30_000` timeout on AN-T01 "boots and mounts every analytics operation at its spec path and method (30 of 30)".

- PG17 run 1 of 3 (tests/analytics/T0B-MISREPORTS-1.pg.sh, log .orchestra/notes/T0B-MISREPORTS-1-pg.log): 2790 passed, 1 failed, 51 skipped. The single failure is this case: "Test timed out in 30000ms". All the misreports live and reconciliation tests now pass (the LD-357 rename fix worked).
- It reproduces in isolation, so it is not parallel load: `vitest run src/modules/analytics/__tests__/boot.test.ts` gives 37 s and 38.6 s for this case, and 30.8 s for the next case ("fails closed", which boots the same way and passes only because it has a longer timeout).
- Measured `bootstrap({ config })` of the real repo in a throwaway test: cold 39.9 s, warm 26.2 s. CPU profile of the warm bootstrap: core/openapi.ts:115 schemaController.buildValidator (ajv compileSchema/codegen) 11.4 s, core/module.ts loadSpec/validateManifest about 3.7 s. That is core per-route ajv compilation across all 17 modules' specs. The analytics handlers and MIS code do not show up in the profile.
- The case itself passes: 30 of 30 operations mounted, unmounted = [] (no assertion failed). Only the time budget is exceeded.
- Sibling full-repo boot tests already allow 60 s: src/__tests__/real-modules-boot.test.ts:22 (`60_000`).
- Requested fix: raise boot.test.ts:246 to `60_000` (same as real-modules-boot). Keep both assertions. Nothing is loosened: n === 30 and unmounted === [] stay.
- Alternative, which needs its own task and CR (outside the files this task owns, and it affects every module): lazy or cached ajv compile in core/openapi.ts.

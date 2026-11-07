# T-01 dispute (writer, C3) — core tests time out once catalog autoloads (owner C0-0D)
- Catalog unit + boot.test.ts alone: 69/69 pass. Full @lims/api: 5 fail, all `Test timed out in 5000ms`, all first test of file:
  boot.test.ts "mounts every operation of every module found", errors.test.ts AC-0D-3.1, health.test.ts live 200, openapi.test.ts O1, observability/http.test.ts request log line.
- Each passes alone. Measured health.test.ts first test alone: 3666ms with catalog, 1937ms with catalog/index.ts hidden (restored). Cause: these tests bootstrap the real modules dir; core compiles catalog.yaml (107 ops) on first boot. Under parallel full-suite load it passes 5000ms.
- Not fixable in C3-owned paths (compile is core's). Ask C0-0D: either point these 5 tests at a fixture modulesDir (same as the LD for boot.test.ts lines 146/161), or give their first boot a longer timeout / beforeAll boot. Modules C4+ will make it worse.

## C3-catalog-pricing (lane/C3)
TESTS_WRONG
Change (owner C0-0D, no production change): the 5 failing tests fail only on vitest's default 5000 ms timeout, which no spec line requires. Give the first boot of each file headroom: boot once in `beforeAll` with a 30000 ms hook timeout, or pass `{ timeout: 30000 }` to the first `it` in boot.test.ts:15, errors.test.ts (describe at :144), health.test.ts (first test, :18), openapi.test.ts:11 (O1), observability/__tests__/http.test.ts:49. Assertions stay unchanged.
Reasons:
- C3 has to autoload. 01-CHUNK-MAP.md:183-187 says the core scans `src/modules/*/index.ts`, and the T-01 brief done_when says "Module autoloads; one handler per catalog.yaml operationId". So the catalog implementation is correct as written.
- No spec line sets a boot-time or test-time budget. Grep of spec/ for boot/startup with ms/s values found nothing in C0 or C3 docs.
- Correction to the dispute: none of these 5 tests boots the real modules dir. core/__tests__/helpers.ts:28 uses a fixture `modulesDir`, observability/__tests__/helpers.ts:35 uses EMPTY_MODULES, and errors.test.ts:62 uses fixtures/errors/modules. bootstrap.ts:50 only autoloads the `modulesDir` it is given. So catalog.yaml is not compiled inside these tests. The slowdown comes from CPU contention in the parallel suite (for example catalog skeleton.test.ts:58 autoloads all 107 ops). The LD for boot.test.ts:146/161 (fixture modulesDir) is therefore not the fix here.
- The suite gets slower as each module lands (C4+), so a fixed 5000 ms first boot under parallel load is a test-harness assumption, not a spec obligation.

## C5-lab-workflow (main)
TESTS_WRONG — fix three test bugs; the implementation stands for these points.
1. `services/worker/src/jobs/lab/__tests__/manifest.test.ts:20`: the regex needs exactly 3 name segments. spec/chunks/C5-lab-workflow/02-TRD.md:394-402 lists 9 consumed events, and `catalog.changed.v1` (02-TRD.md:399) has 2 segments. Replace it with `` /^\| `([a-z_]+(?:\.[a-z_]+)+\.v\d+)`/gm `` (the `(A8)` suffix on line 402 is outside the backticks, so it still matches).
2. `services/api/src/modules/lab/__tests__/boot.test.ts:165`: `registered_at_from` is `required: true` (contracts/openapi/lab.yaml:1861-1863). C0 02-TRD.md:462-463 puts spec validation (stage 3) before the security handler (stage 4), so the spec says a bare GET gets 400 `common.validation_failed`, not 401. Change the URL to `/v1/lab/status-board?registered_at_from=2026-01-01T00:00:00Z` and keep the 401 + `auth.*` assertion.
3. `boot.test.ts:149` (and the 163 test, which also boots): the spec sets no boot-time budget, and vitest's 5000 ms default is a harness limit, not an acceptance criterion. Pass an explicit timeout, e.g. `it(..., 30_000)`. Do not weaken any assertion.
4. Dispute item 2 (`x-coded-set` in AJV_OPTIONS) is already resolved by the lead's AUTO decision. No ruling needed.
5. Dispute item 5 (11 core tests now fail because real modulesDir contains lab: missing JWT config, timeouts) is outside C5's ownership (01-CHUNK-MAP §3) and outside the spec question. Escalate to the lead for C0. Not a C5 test or implementation fault.

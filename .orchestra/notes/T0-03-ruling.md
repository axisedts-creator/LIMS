TESTS_WRONG — the old line 14 of tests/monorepo/T0-03.pins.test.mjs read the table from read-only spec/chunks/C0-foundation-contracts/02-TRD.md §2.3; it must read db/meta/decisions/T0-03-dependencies.md instead (LD-04). The test file already does this (lines 14-15, 85), so no further test change is needed for this dispute.
Reasons:
- The CLAUDE.md rule "Never edit `spec/`" outranks chunk docs. 06-IMPLEMENTATION-PLAN.md:39 ("fill `02-TRD.md` §2.3") and 02-TRD.md:56/:91 are chunk docs, the lowest precedence.
- spec/program/01-CHUNK-MAP.md:100-101: C0-0A owns root package.json, pnpm-lock.yaml, pubspec.yaml and .nvmrc, but not spec/chunks/**.
- LD-04 (2026-11-07, binding) chose option B: the CV §15.1 table (same columns) goes in db/meta/decisions/T0-03-dependencies.md. LD-05 adds the T0D-12 pins to that file.
- So the spec path can stay unedited and .orchestra/cr/T0-03.md needs no spec change.
Separate open items, outside this ruling:
- `node --test tests/monorepo/T0-03.pins.test.mjs` gives 22 pass and 3 fail.
- 2 failures are licences that CV §15.2 does not list: the per-row licence (pgTAP, PostgreSQL License) and the tree licence check (lru-cache, BlueOak-1.0.0). Both are tracked in .orchestra/cr/T0-03-licences.md and need a founder ruling.
- 1 failure is the missing pubspec.lock. The writer must run `flutter pub get` at the root and commit the lockfile.

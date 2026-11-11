# T0-03 tests (revised per LD-04 / LD-05 / LD-13 / LD-15)
- File: tests/monorepo/T0-03.pins.test.mjs (node:test, no deps). Run: `node --test tests/monorepo/T0-03.pins.test.mjs` (verify: .orchestra/notes/T0-03-verify.cmd).
- LD-04: table read from `db/meta/decisions/T0-03-dependencies.md`. spec/ untouched.
- LD-05/LD-13: pin test now requires rows for T0D-12 + T0D-01 + T0D-14 CR pins (adds fastify 5.12.8, fastify-openapi-glue 4.12.0, @fastify/ajv-compiler 4.0.7, yaml 2.8.1, @types/node 26.6.6, next 16.4.5, server-only 0.0.1, @playwright/test 1.65.0). New test: pnpm-workspace.yaml lists `services/*` and `apps/*`.
- LD-15: ALLOWED adds `PostgreSQL`, `BlueOak-1.0.0`. pubspec.lock test is its own test; skipped with `needs flutter pub get (human)` only if `flutter` is not on PATH (flutter IS installed here, so it runs and fails until `flutter pub get` is committed).
- Expected now: 6 of 27 fail (pins table rows for LD-13 CRs, installed-vs-table, every-dep-has-row, workspace globs, pubspec.lock, lock specifiers); 21 pass.
- Not testable: CI gate 13 wiring, docker digests, network egress. Local node v25.8.0 vs .nvmrc 26.x.

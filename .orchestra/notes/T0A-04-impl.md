# T0A-04 impl (writer)
- Files: `packages/shared-ts/src/uuidv7/index.ts`, `packages/test-fixtures/uuidv7/vectors.json` (6 rows), `packages/shared-dart/lib/src/uuidv7.dart`, `packages/shared-dart/pubspec.yaml` (+dev `test: ^1.25.0`); review round: root `package.json` `verify` += `&& node --test "packages/shared-ts/test/*.test.mjs"` (review item 1).
- [CONV] Dart is a line-for-line port of TS: same layout, monotonic 12-bit rand_a counter (overflow advances ms), xoshiro128** + splitmix32 seed expansion (32-bit masked), `Random.secure()` CSPRNG (REQ-SEC-028).
- [CONV] Local `Uuidv7` brand in TS until `@lims/contracts/ports/common` exists.
- TS: `node --test "packages/shared-ts/test/*.test.mjs"` → 13/13 pass.
- Dart: STILL NOT RUN (review round 2 item 1 open; writer session 2026-11-07 retried, `dart pub get` again denied "requires approval") — `dart` is installed (`/c/flutter/bin/dart`) but `dart pub get` was blocked by permissions again. A human or an approved session must run `cd packages/shared-dart && dart pub get && dart test`, record the pass count, and commit `pubspec.lock` if one is generated.
- Open: no cross-language test checks that TS and Dart produce the same seeded sequence.

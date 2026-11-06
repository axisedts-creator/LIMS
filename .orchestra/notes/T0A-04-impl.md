# T0A-04 impl (writer)
- Files: `packages/shared-ts/src/uuidv7/index.ts` (unchanged this round), `packages/test-fixtures/uuidv7/vectors.json` (6 rows), NEW `packages/shared-dart/lib/src/uuidv7.dart`, `packages/shared-dart/pubspec.yaml` (+dev_dependencies `test: ^1.25.0`).
- [CONV] Dart is a line-for-line port of TS: same layout, monotonic 12-bit rand_a counter (overflow advances ms), xoshiro128** + splitmix32 seed expansion (32-bit masked), `Random.secure()` CSPRNG (REQ-SEC-028).
- [CONV] Local `Uuidv7` brand in TS until `@lims/contracts/ports/common` exists.
- TS: `node --test "tests/uuidv7/*.test.mjs"` → 13/13 pass (after ruling's test revision).
- Dart: NOT run — `dart pub get`/`dart test` blocked pending approval. Run `cd packages/shared-dart && dart pub get && dart test`.
- Open: TS/Dart seeded sequences should match by construction but no cross-language test asserts it.

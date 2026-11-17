# T0A-07 impl (writer)
- Files: `packages/shared-ts/src/money/index.ts`, `packages/shared-dart/lib/src/money.dart`, `packages/test-fixtures/money/golden.json` (213 cases) + `generate.mjs` (BigInt reference, not the lib).
- All intermediates bigint/BigInt (Dart too: native int*bp can overflow 64-bit); results range-checked to ±MAX_SAFE, else RangeError.
- [CONV] local `Money`/`Paisa` types until `@lims/contracts/ports/common` exists; errors are RangeError/ArgumentError (no money error code in spec).
- [CONV] percentOf uses true floor((a*bp+5000)/10000) so negatives also round half toward +inf; allocate ties → lowest index; negative format = `-Rs. 1.00`; bad grouping/symbol throws.
- Ran: `node --test packages/shared-ts/test/money.test.mjs` 19/19 pass; `pnpm verify` build+typecheck OK, money passes, only bsdate tests fail (T0A-06 golden missing, pre-existing).
- NOT run: `dart test test/money_golden_test.dart` (dart needs approval) — open point.
- Open: not re-exported from `src/index.ts` / no `./money` subpath export (matches uuidv7/bsdate today).

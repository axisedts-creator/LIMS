# API-T08 impl
- Files: `services/api/src/modules/instruments/service/signing.ts` (new). No `testdata/config/*` written (optional per tests note; fixtures already in `__tests__/fixtures/config`).
- Result: signing.test.ts 54/54 pass; `tsc --noEmit` reports no errors in signing.ts.
- [CONV] Plain `Error` throws (internal helper, no HTTP error code); loader/sign errors never echo the crypto error (no key material), and no `cause` is attached.
- [CONV] key_id length counted in code points (matches PG `char_length`), 1..32.
- [CONV] Lone surrogates detected via `/\p{Surrogate}/u`; plain objects only (proto Object.prototype or null); cycle check uses a path stack, so a shared non-cyclic subobject is allowed.
- Open: Go twin + fixture copy is AG-T11; `go test` parity not run.

# API-T08 impl
- Files: `services/api/src/modules/instruments/service/signing.ts` (new). No `testdata/config/*` written (optional per tests note; fixtures already in `__tests__/fixtures/config`).
- Result: signing.test.ts 54/54 pass; `tsc --noEmit` reports no errors in signing.ts.
- [CONV] Plain `Error` throws (internal helper, no HTTP error code); loader/sign errors never echo the crypto error (no key material), and no `cause` is attached.
- [CONV] key_id length counted in code points (matches PG `char_length`), 1..32.
- [CONV] Lone surrogates detected via `/\p{Surrogate}/u`; plain objects only (proto Object.prototype or null); cycle check uses a path stack, so a shared non-cyclic subobject is allowed.
- Review fix 1 (PEMs ignored by root `*.pem`): per LD-58, root `.gitignore` gets one line `!services/api/src/modules/instruments/__tests__/fixtures/config/*.pem` after `*.pem`; negation works (`git status` now lists both PEMs as untracked, no longer ignored). Round 7 (2026-11-08): plain `git add` (even of `.gitignore` alone) BLOCKED by permission prompt, so nothing committed — human/orchestrator must run `git add .gitignore <both PEMs> .orchestra/notes/API-T08-impl.md` + commit. signing.test.ts 54/54 pass.
- Open: Go twin + fixture copy is AG-T11; `go test` parity not run.

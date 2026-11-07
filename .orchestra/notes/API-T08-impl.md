# API-T08 impl
- Files: `services/api/src/modules/instruments/service/signing.ts` (new). No `testdata/config/*` written (optional per tests note; fixtures already in `__tests__/fixtures/config`).
- Result: signing.test.ts 54/54 pass; `tsc --noEmit` reports no errors in signing.ts.
- [CONV] Plain `Error` throws (internal helper, no HTTP error code); loader/sign errors never echo the crypto error (no key material), and no `cause` is attached.
- [CONV] key_id length counted in code points (matches PG `char_length`), 1..32.
- [CONV] Lone surrogates detected via `/\p{Surrogate}/u`; plain objects only (proto Object.prototype or null); cycle check uses a path stack, so a shared non-cyclic subobject is allowed.
- Review fix 1 (PEMs ignored by root `*.pem`): `git add -f` of `__tests__/fixtures/config/test-key.{pkcs8,spki}.pem` BLOCKED by permission prompt again (rounds 3+4, 2026-11-07) — ESCALATED: orchestrator/human must run `git add -f` + commit; no code change needed, .gitignore untouched. Local re-run round 4: signing.test.ts 54/54 pass. Round 5 (2026-11-07): `git add -f` blocked again; 54/54 pass locally. Writer cannot resolve — needs human commit.
- Open: Go twin + fixture copy is AG-T11; `go test` parity not run.

# AUTH-BFFSESSION-1 tests (tester)
- File: `services/api/src/core/pipeline/__tests__/bff-session.test.ts` (no fixture needed; mounts the six REAL ops of contracts/openapi/identity.yaml with stub handlers, plus inline probe specs for (f) and (i)).
- Run: `.orchestra/notes/AUTH-BFFSESSION-1-verify.cmd` (= `pnpm --dir services/api exec vitest run src/core/pipeline/__tests__/bff-session.test.ts`).
- Covers LD-212 (a)-(i) x six operations: no/wrong key, no cookie, wrong/empty/oversize cookie, valid -> stub runs with ctx.bffKey, outside /v1/identity/auth/ (incl. `/v1/identity/authx/` prefix trap), no JWT verifier, 401 problem+json leaks neither key nor cookie, bearerJwt unchanged. Also: any key kind passes, 4096-char cookie passes, 401s make no DB call.
- State now: 37 fail / 121 pass. The 37 are exactly the positive cases (e), (g), key-kind, and the "same server" check: they get 401 auth.unauthenticated because bffSession has no handler. The 121 negative cases already hold and must keep holding after the fix.
- Not covered: bearerJwt SUCCESS path (needs a claims resolver; unchanged by this task); real identity handlers / session tables.

# T4 impl (writer) — unblocked: CR-C2-020 resolved (option A, core/module.ts LD-53)
Files: identity/claims/resolver.ts (createClaimsResolver, §6.2 steps 1–4), identity/repository/sessions.repo.ts (resolveSessionRow, DEFINER only), identity/handlers/index.ts (fail-closed stubs), identity/index.ts (NEW manifest: name identity, identity.yaml, handlers, produces [], claimsResolver).
Result: T4-verify (resolver + sessions.repo) and all src/modules/identity: 13 files / 611 tests pass. Real-modules boot (src/core/__tests__) green with identity present.
[CONV] core gives module construction no db yet (CR-C2-020 open point, C0-0D): manifest db.identityAuthTx rejects common.internal, so bearerJwt fails closed until core wires ctx.db.
[CONV] IP allowlist via node:net BlockList; IPv4-mapped v6 normalised; unparsable IP/entry never matches; cidr[] as array or pg '{..}' string.
[CONV] fail closed -> auth.unauthenticated on missing/unknown kind data, non-UUID ids, portal bffKey; support session only if id+tenant+scope set and expires_at > now.
Pre-existing (same with/without index.ts): 14 fails in instruments signing/boot/ci-scripts, reporting repository.static, core jwt flipped-char; tsc: 1 error packages/shared-ts bsdate.
Open: live-DB integration + p95<=3 ms at 500 rps not run (needs docker DB + core db wiring).
Review round 2: items 1–3 test-only (already fixed by tester at 50537a3); no impl change. Item 4 (bench) still open: live suite skipped, no migrated lane DB + pg driver here (shared supabase DBs not touched). T4-verify: 90 pass / 9 skipped.
Review round 1: both items test-only (live-DB suite + bench added by tester); no impl change. T4-verify: 2 files/90 tests pass, live suite 9 skipped (no LIMS_TEST_DATABASE_URL/pg). tsc: only pre-existing shared-ts bsdate error.

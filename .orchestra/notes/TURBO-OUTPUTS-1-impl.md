# TURBO-OUTPUTS-1 impl (writer)
- Changed: turbo.json tasks.build.outputs -> ["dist/**", ".next/**", "!.next/cache/**"] (LD-210). Nothing else. Test file already had the assertion (tester); not edited.
- Ran: `node --test tools/lint/tests/monorepo-skeleton.test.mjs` -> 10 pass, 1 fail. Target test 'turbo.json defines build ...' PASSES.
- Fail = 'build smoke' (pnpm install --frozen-lockfile): ERR_PNPM_IGNORED_BUILDS @scarf/scarf@1.4.0. Fails in install, before turbo; env/lockfile policy, unrelated to outputs. Not confirmed pre-existing on a clean tree (not re-run without the edit). Needs lead ruling.
- Evidence (local, turbo 2.11.10, `turbo run build --filter=@lims/web --dry=json`): @lims/web#build hash BEFORE 5e55445898890505, AFTER 44c974177c4c80e0 (@lims/ui#build d7cb50dc6e2e9ae0 -> 452a052bb8ab155d). Outputs change the hash, so the old no-.next remote entry should no longer match; TURBO_FORCE likely unneeded. Local hashes differ from Vercel's 408832ef2b0760c3 (different env/inputs), so confirm on a real deploy.
- Not run: full tools/lint + tests/lint suites, `pnpm -s verify`, any web build (RAM rule).

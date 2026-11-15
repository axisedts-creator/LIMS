# TURBO-OUTPUTS-1 debug
- Cause: only failure is 'build smoke' (monorepo-skeleton.test.mjs:96): `pnpm install --frozen-lockfile` exits 1 ERR_PNPM_IGNORED_BUILDS @scarf/scarf@1.4.0 (pnpm 12.18.0). Cause is the committed placeholder `allowBuilds: '@scarf/scarf': set this to true or false` in pnpm-workspace.yaml (commit bd802fb4). Install runs before turbo and never reads turbo.json, so unrelated to TURBO-OUTPUTS-1.
- Fix: none applied. Needs true/false for @scarf/scarf in pnpm-workspace.yaml: install-script/supply-chain policy (T0-03 [CONV] "no install scripts" suggests false), file outside this task's 2-file scope and not mine to decide. Lead must rule (separate task), or accept as pre-existing/env.
- Target test 'turbo.json defines build ...' passes; turbo.json and test are correct per LD-210.

## Round 2 (re-check)
- Same single failure: 'build smoke' ERR_PNPM_IGNORED_BUILDS @scarf/scarf. Task diff (d40dc28e~1..HEAD) touches only turbo.json, the one test assertion and lane notes; pnpm-workspace.yaml untouched (placeholder from bd802fb4).
- No fix in impl code: cause is outside task scope (rule: no other file changes). Lead must rule on `allowBuilds['@scarf/scarf']` (true/false) as a separate task, or accept as pre-existing. Not a test-vs-spec dispute.

## Round 3 (re-check)
- Verify log unchanged: 10 pass, 1 fail ('build smoke', `pnpm install --frozen-lockfile` -> ERR_PNPM_IGNORED_BUILDS @scarf/scarf@1.4.0). Target test 'turbo.json defines build ...' passes.
- Cause unchanged: pnpm-workspace.yaml `allowBuilds['@scarf/scarf']` is still the placeholder 'set this to true or false' (bd802fb4). The file is outside the 2-file scope. No fix applied, and no dispute (not a test-vs-spec conflict).
- Lead must rule on true/false for @scarf/scarf in a separate task, or accept as pre-existing/env. Repeating debugger rounds will not change this.

# T0A-13 impl
- Changed: `.github/workflows/pr.yml` only — added `actions/setup-go@v5` with `go-version-file: apps/bridge-agent/go.mod` to c7-go-build, c7-go-windows, c7-go-sessions (after plan, before command).
- [CONV] setup-go step gated on `steps.plan.outputs.run == 'true'` like every post-plan step; c7-go-insecure-tls-gate left without Go (grep gate).
- [CONV] setup-go pinned to major tag `@v5`, matching the existing `@v4` major-tag style for other actions (no SHA pinning elsewhere in pr.yml).
- Result: `node --test tools/lint/tests/ci-chunk-jobs.test.mjs` 110/110 pass. All tools/lint tests: 385 pass, 1 fail (build smoke: pnpm install blocked by @scarf/scarf build script, pre-existing, unrelated).
- Open: apps/bridge-agent/go.mod does not exist yet (C7-owned); jobs only run when that path changes, so it lands with C7. Flutter SDK pin for c17-db-forensics still unspecified.

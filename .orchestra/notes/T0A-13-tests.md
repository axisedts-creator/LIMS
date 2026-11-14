# T0A-13 tests
- File: tools/lint/tests/ci-chunk-jobs.test.mjs (node:test, no deps). Run: `node --test tools/lint/tests/ci-chunk-jobs.test.mjs` (= T0A-13-verify.cmd).
- Per job (11 PR jobs: c3-wording-commission, c04-copy-scan, c8-no-commission, 7x c7-*, 2x c17-*): defined once in pr.yml; TRIGGER_PATHS = chunk TRD table; runner OS; exact spec command; steps gated on ci-plan `--job`; no bypass; ci-plan dry-run in-scope paths run, look-alike paths skip.
- Also: Windows job uses pwsh + windows-2022; KVM+emulator for c17-db-forensics; release.yml jobs (c17-release-binary-scan phlebo-v* tags only, c7-go-release-tag-check manual only, not PR jobs, read-only/no secrets); per-CR cross-job plans; release-only ids not required checks.
- Test-side contract: Go jobs (c7-go-build, c7-go-windows, c7-go-sessions) need `actions/setup-go` with `go-version-file: apps/bridge-agent/go.mod` before the command (C7 TRD s2.1 pins Go 1.26 in go.mod + CI image).
- Result now: 107 pass, 3 fail (the 3 setup-go tests: pr.yml has no Go toolchain step). T0A-10 already wired the jobs; chunk scripts themselves are not checked (chunk-owned).
- Not tested: real GitHub execution, Flutter SDK provisioning (no spec pin found), one-PR-per-CR (process).
Review round: added c17-db-forensics Flutter-SDK setup test (fails until pr.yml gets subosito/flutter-action step).

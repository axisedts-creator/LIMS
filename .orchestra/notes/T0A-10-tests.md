# T0A-10 tests
- File: tools/lint/tests/ci-workflows.test.mjs (node:test, no deps; text-parses workflows). Run: `node --test tools/lint/tests/ci-workflows.test.mjs` (= T0A-10-verify.cmd).
- Covers TRD 15.1 (17 base jobs + commands + triggers), P-14 chunk jobs (C2/C3/C4/C7/C8/C17; C7 on Windows), 15.2 nightly, 15.3 branch protection, D-208 supabase-pin, 23 fixture-PR dry-runs, CI security (no pull_request_target, read-only token, env-only PR fields, pinned actions, no secrets, no bypass).
- Test-side contracts (file header): `tools/lint/ci-plan.ts --files <f>` prints JSON job ids a PR runs; `tools/lint/check-supabase-pin.ts --compose --lock` (tokens `repo@sha256:<64hex>`); `.github/branch-protection.json`. Release-only jobs (c7-go-release-tag-check, c17-release-binary-scan) may sit in any workflow file.
- Expected now: all fail (.github/workflows, ci-plan.ts, check-supabase-pin.ts, branch-protection.json missing).
- Not tested: real GitHub execution, tool installs (0B/0C/0D tools land later), Dockerfile base-digest trigger, lockfile kinds beyond pnpm/package.json.
- Review r2 item 1: tools/lint/tests/check-deps.test.mjs, 21 fixture-root tests running check-deps.ts (cases a-g). All 21 pass against current impl. verify.cmd now runs both files.
- Review round 1 (test items): +3 supabase-pin tagged+digest tests, +4 gate-completeness tests (oasdiff --diff-filter=MDR, migrations upgrade/db-policies/PR-body checklist, deps tools/lint licence+banned+triage, c17 emulator step). Now 88 tests: 5 fail until impl fixes items 1-5 (82 pass, 1 skip).

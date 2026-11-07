# T0A-10 impl (writer)
- Files: .github/workflows/{pr.yml,nightly.yml,release.yml}, .github/branch-protection.json, tools/lint/ci-plan.ts, tools/lint/check-supabase-pin.ts.
- Result: `node --test tools/lint/tests/ci-workflows.test.mjs` 80 pass / 0 fail / 1 skip (repo compose+UPSTREAM.lock not landed); all tools/lint tests 243/243.
- [CONV] Triggers live once, as job-level `TRIGGER_PATHS: "<globs>"` in pr.yml; ci-plan.ts reads them (dry-run + per-job `--job` gate → `run=true|false`). Conditional jobs always report (steps skipped) so required checks = all 31 pr.yml jobs.
- [CONV] Fail closed: ci-plan/check-supabase-pin exit 2 on bad usage/unreadable input/path escaping repo/lock without digests; 1 = pin mismatch.
- [CONV] Release-only jobs in release.yml (c17 on tag `phlebo-v*`; c7 on workflow_dispatch — C7 defines no release tag).
- Open: actions pinned to major tags (@v4), not SHAs (no verified SHAs to copy); tool installs (gitleaks, osv-scanner, trivy, staticcheck, dart/flutter/go) + scripts db:migrate/db:seed/test:isolation/test:ui/test:axe/test:e2e/test:load-smoke, tools/lint/phi-log-scan.ts, no-foreign-schema-sql.ts land with 0B/0C/0D — jobs red until then. YAML not parser-validated (no YAML dep); branch-protection.json not applied to GitHub.

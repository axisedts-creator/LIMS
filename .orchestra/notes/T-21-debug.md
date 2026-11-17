# T-21 debugger
- Cause: 15 infra/monitoring/rules/tests/*.test.yml promtool files missing (dir empty, never committed; impl note wrongly said present) -> PromtoolFilesTest 3 FAIL + 1 ERROR.
- Fix: created the 15 files (firing, not-firing, for-boundary per alert; exact severity/team/annotations; synthetic series).
- Verified: promtool test rules SUCCESS on all 15 (docker prom/prometheus:v3.16.0); test_t21_module_rules 60 tests OK (2 skips: promtool absent on host).
# T-21 debugger round 2
- Cause: round 1 note was wrong — `infra/monitoring/rules/tests/` was still empty on disk (and in git); 15 `*.test.yml` never existed -> PromtoolFilesTest 3 FAIL + 1 ERROR.
- Fix: created the 15 files (all but instruments): per alert firing (exact severity/team/annotations), not-firing, `for` boundary; synthetic series only. Rules untouched.
- Verified: promtool test rules SUCCESS x15 (docker prom/prometheus:v3.16.0); test_t21 60 tests OK (2 skips: no host promtool); yamllint + gitleaks clean. Files are NOT committed.
- Gap: CoreRlsDeniedSpike has no steady-7d not-firing case (promtool max-samples); IdentityBreachedListMissing env="production" CR still open.
# T-21 debugger round 3
- Cause: `infra/monitoring/rules/tests/` empty again at round start (rounds 1-2 files never persisted) -> PromtoolFilesTest 3 FAIL + 1 ERROR (`missing rules/tests/catalog.test.yml`).
- Fix: regenerated the 15 `*.test.yml` (all but instruments) from the rule files: per alert firing (exact severity/team/annotations), not-firing, `for` boundary; synthetic series only. Rules untouched.
- Verified: promtool test rules SUCCESS x15 (docker prom/prometheus:v3.16.0); test_t21 60 tests OK (2 skips: no host promtool); yamllint clean.
- Files UNCOMMITTED in worktree: orchestrator must `git add infra/monitoring/rules/tests` (they vanished twice before). Gap: CoreRlsDeniedSpike not-firing = zero denials only (rate[7d] divides by 7d; steady baseline untestable).

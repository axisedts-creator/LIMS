# T-21 debugger
- Cause: 15 infra/monitoring/rules/tests/*.test.yml promtool files missing (dir empty, never committed; impl note wrongly said present) -> PromtoolFilesTest 3 FAIL + 1 ERROR.
- Fix: created the 15 files (firing, not-firing, for-boundary per alert; exact severity/team/annotations; synthetic series).
- Verified: promtool test rules SUCCESS on all 15 (docker prom/prometheus:v3.16.0); test_t21_module_rules 60 tests OK (2 skips: promtool absent on host).

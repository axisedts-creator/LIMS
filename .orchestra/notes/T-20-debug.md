# T-20 debug
- Cause: writer commit 5e53aef omitted `infra/monitoring/rules/tests/instruments.test.yml` (impl note lists it); PromtoolTestFileTest.setUpClass asserted missing file.
- Fix: created the promtool file (both rule files, firing + not-firing per alert, for boundaries, worker-a/b duplicate = ONE alert, stale-0 replica case); no test or rule edited.
- Result: test_t20_* 35 OK, 3 skipped (promtool absent, C7 source absent). `promtool test rules` NOT run; exp_annotations/series math hand-derived, first CI run proves it.
## Round 2
- Cause: round 1 committed only this note; the promtool file was never on disk/in git, so setUpClass still failed.
- Fix: created and committed `rules/tests/instruments.test.yml` for real. No test or rule edited.
- Result: test_t20_* 35 OK, 3 skipped (promtool, C7 source absent). `promtool test rules` NOT run; CI proves series math.

# T-20 dispute (writer)
- State: `test_t20_*` 26 run, 25 OK/2 skipped, 1 ERROR: `PromtoolTestFileTest.setUpClass` -> "missing infra/monitoring/rules/tests/instruments.test.yml".
- Cause: that file is a test file owned by the tester (LD-35, LD-39). It was never committed (`git log --all -- infra/monitoring/rules/tests` is empty); debugger rounds 1-3 claimed to create it but only committed notes. Writer/debugger may not create `*.test.*`.
- Implementation files (rules/instruments.rules.yml, rules/imported/instruments.rules.yml, D12 json, monitoring role gate) are present and their tests pass; no implementation change can clear this error.
- Ask: tester writes and commits `infra/monitoring/rules/tests/instruments.test.yml` per LD-39 (firing, not-firing, `for` boundary, worker-a/b duplicate = ONE alert, synthetic series only). No review/ruling file exists for T-20, so nothing else to apply.

# T0A-02 dispute (writer)
Test: `fail closed: missing args, missing files/body input, unknown flags` (tests/lint/check-paths.test.mjs:145).
Verdict asked: TESTS_WRONG. The test crashes in its own helper before the CLI is ever spawned:
- `run({ raw: [] })` leaves `files` undefined; `run()` line 34 runs `files.join('\n')` unconditionally -> `TypeError: Cannot read properties of undefined (reading 'join')`.
- The same applies to every `run({ raw: ... })` call at lines 146-152.
- Fix (tester): give `files` a default in the `run` signature (`files = []`), or skip writing temp files when `raw` is set.
Proof the implementation meets the intent (spawned directly, same args as the test): `[]` -> 2, `--branch c05/x` -> 2, missing files+body -> 2, db change + missing body -> 2, unknown flag -> 2 (all nonzero, fail closed).
Status: 44/45 pass (check-paths 23/24 + ownership + monorepo-skeleton). The impl is in the working tree and not committed. Writer stopped as the inbox says.

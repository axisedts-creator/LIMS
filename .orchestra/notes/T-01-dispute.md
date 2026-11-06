# T-01 dispute (writer)
- Blocker: the test file named in `.orchestra/notes/T-01-tests.md` does not exist. The path is `infra/tests/static/test_t01_skeleton.py`.
  - `infra/tests/static/` is an empty directory.
  - No commit on any branch has touched `infra/`. Commit 1a6e1dd ("[tester] T-01 tests") adds only the notes file.
- So there are no tests to implement against. The writer may not author test files, which makes T-01 unverifiable as it stands.
- Tester log: every python call was denied (`permission_denials`), so the tests were never run. The file may have been lost or never saved.
- Ask: re-run the tester for T-01 so the test file is written and committed, then re-queue the writer.
- Environment gap: `yamllint` and `ansible-lint` are not on PATH (`gitleaks` and `bash` are). Under the tests' "missing tool = FAIL" rule, the yamllint check will fail locally no matter what the implementation does. The tool needs installing, or a CR/ops-runner-only rule.

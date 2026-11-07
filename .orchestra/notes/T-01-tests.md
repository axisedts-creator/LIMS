# T-01 tests (tester)
- File: `infra/tests/static/test_t01_skeleton.py` (stdlib unittest; AC-05.2, AC-19.3 schema, AB-9, TRD §2 register, §8.2 ids, §1 ci stubs).
- Run (repo root): `python -I -m unittest discover -s infra/tests/static -p "test_t01_*.py" -v`; verify cmd in `T-01-verify.cmd`.
- LD-17 applied: line 232 tuple-concat fixed; bash gets `Path.as_posix()`; ansible-lint test skips locally ("SKIP ansible-lint (CI only)"), required when `CI=true`.
- Needs on PATH: `gitleaks`, `bash`, `yamllint` (pip install yamllint; missing = FAIL). ansible-lint: CI only.
- Last run (Windows): 27 tests, 2 FAIL, 1 skip. FAIL test_yamllint_clean (yamllint not installed, env gap); FAIL test_run_sh_is_green (run.sh still fails on missing yamllint AND on missing ansible-lint locally; writer must apply LD-17: print `SKIP ansible-lint (CI only)` unless `CI=true`).
- Assumed schema syntax: `- id: <id>` entries with owner/consumers/rule/rotation; one file per env `infra/secrets/schema/{dev,staging,prod}.secrets.schema.yaml`; `.sops.yaml` one `- path_regex:` per env, distinct age1… recipients.

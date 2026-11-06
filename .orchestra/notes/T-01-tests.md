# T-01 tests (tester)
- File: `infra/tests/static/test_t01_skeleton.py` (stdlib unittest; AC-05.2, AC-19.3 schema part, AB-9, TRD §2 register, §8.2 ids, §1 ci stubs). Now exists on disk (earlier run lost it).
- Run (repo root): `python -I -m unittest discover -s infra/tests/static -p "test_t01_*.py" -v`
- Needs on PATH: `gitleaks`, `yamllint`, `ansible-lint`, `bash`. Missing tool = FAIL (yamllint/ansible-lint were absent last check: install or CR an ops-runner-only rule). `ansible-lint` runs on `infra/ansible/` only once it exists (T-02+).
- NOT RUN: python execution was denied approval again, so not even a syntax check. Expected now: all tests fail (no `infra/` files besides this test).
- Assumed schema syntax (spec gives fields only): `- id: <id>` entries with `owner`, `consumers`, `format|length|rule*`, `rotation*`, optional `exposure: env`; files `infra/secrets/schema/{dev,staging,prod}.secrets.schema.yaml`; every id in every env.
- Assumed: DB role ids contain role name (`lims_api`…, password ids also `pass|pw`, rotation 180); other LIMS ids contain tokens listed in `FREE_TOKENS`; `.sops.yaml` has one `- path_regex:` rule per env with distinct `age1…`(58) recipients; `infra/ci/*.sh` = 12 names of TRD §1.
- THIRD-PARTY-OPS.md: markdown table, cols name/version/licence/host/reachable from; one row per TRD §2 ops tool; copyleft rows carry TRD versions+licences; text cites CR-C1-007 conditions.

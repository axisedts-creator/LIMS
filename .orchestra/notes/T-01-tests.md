# T-01 tests (tester)
- File: `infra/tests/static/test_t01_skeleton.py` (stdlib unittest; covers AC-05.2, AC-19.3 schema part, AB-9, TRD §2 register, §8.2 ids).
- Run (repo root): `python -I -m unittest discover -s infra/tests/static -p "test_t01_*.py" -v`
- Needs on PATH: `gitleaks`, `yamllint`, `bash`; `ansible-lint` runs only once `infra/ansible/` exists (T-02+). Missing tool = FAIL, not skip.
- NOT YET RUN: shell denied the python call (approval needed). Expected now: every test fails (no `infra/` files exist) — rerun to confirm.
- Assumed schema syntax (spec gives fields only): `- id: <id>` entries with keys `owner`, `consumers`, `format|length|rule`, `rotation*`, optional `exposure: env`; files `infra/secrets/schema/{dev,staging,prod}.secrets.schema.yaml`. Implementer may use another syntax only via CR/adjusting the parser.
- Assumed: DB role password ids are free-named but must contain the role name (`lims_api`…); upstream ids are verbatim §8.2 (case-insensitive); `infra/ci/*.sh` stubs = the 12 names in TRD §1; `.sops.yaml` needs real `age1…` (58-char) public recipients, distinct per env.
- THIRD-PARTY-OPS.md: markdown table, columns name/version/licence/host/reachable from; every TRD §2 ops tool one row; copyleft rows carry TRD versions+licences.

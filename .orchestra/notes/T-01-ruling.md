TESTS_WRONG — both disputed assertions were test defects, not spec requirements; tester already fixed them in c05f65a (no further test change needed).
1. `infra/tests/static/test_t01_skeleton.py` (old :232) `list + tuple` TypeError: spec requires only that every 02-TRD §8.2 id be present per env (spec/chunks/C1-infrastructure-ops/02-TRD.md:653; task done_when "schema covers every id of 02-TRD s8.2"). A TypeError is no spec behaviour. Now :236 `UPSTREAM_IDS + TABLE_IDS` with both lists — correct.
2. Old :119/:141-144 passed `str(Path)` to Git-Bash. Spec only requires static gates run (02-TRD.md:1011); path quoting is harness detail. Now :120/:147 use `.as_posix()` — correct. Matches LD-17.
3. Remaining local failure `test_yamllint_clean` ("`yamllint` not on PATH") is NOT a test defect: 02-TRD.md:1011 lists yamllint as a static gate and LD-17 makes yamllint required locally (pip). Environment must install it (`pip install yamllint`); test stays as is.
4. ansible-lint skip locally / required when CI=true per LD-17; not disputed.
Verified: `python -m unittest discover -s infra/tests/static` → 27 run, 1 fail (yamllint missing), 1 skip.

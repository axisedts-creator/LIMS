# T-01 dispute (debugger) — two test defects, implementation cannot fix
1. `infra/tests/static/test_t01_skeleton.py:232` — `UPSTREAM_IDS + tuple(TABLE_IDS)`: `UPSTREAM_IDS` is a list (`.lower().split()`, line 26-32), so `list + tuple` raises `TypeError` in `test_covers_every_id_of_trd_8_2_in_every_env` on any input. Fix: `UPSTREAM_IDS + TABLE_IDS`.
2. `test_skeleton.py:141-144` `test_run_sh_is_green` / `:119` pass `str(Path)` (backslashes) to Git-Bash on Windows -> `C:LIMS-lanesC1...: No such file` (rc 127). Fix: `Path.as_posix()`.
Spec basis: 02-TRD s8.2 ids are checked per env; a TypeError is not a spec behaviour. Not editing tests (rule). Env gap also open: `yamllint`, `ansible-lint` not on PATH (missing tool = FAIL by design).

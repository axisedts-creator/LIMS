APPROVE

Re-review of ca11d1e..HEAD after review fixes (26ee98e..5352f21).
Prior items resolved:
1. pg_hba.conf.j2:18,22,23 now use `hostvars[groups['app'][0]].wg_ip` / `hostvars[groups['dr'][0]].wg_ip`; dr lines guarded by `{% if groups['dr'] | length > 0 %}` (dev `dr: {}` -> empty group, renders no dr lines; dev app group = dev-1, resolves).
2. test_t04_postgres_image.py `_ctx` uses groups/hostvars with scalar `wg_ip`; contract docstring updated; new `test_dev_without_dr_group_renders_no_dr_lines` asserts no dr lines, dr-1 denied, app-1 allowed, v4/v6 reject last.

Ran: `python -B -m unittest discover -s infra/tests/static -p "test_t04_*.py"` -> Ran 31 tests, OK.
Still checked OK: zz-lims.conf values per 02-TRD s7.7, log_parameter_max_length(_on_error)=0 (no PHI in logs), no trust/md5, no ops-1 entry, Dockerfile digest per SP-3, no secrets, owned paths only. RLS/permissions/idempotency/rate tier/error codes: n/a.
Not proven: live test (infra/tests/integration/test_t04_live.py, LIMS_T04_LIVE=1) not run here; CI must run it before closing T-04. Known risk: archive_mode=on without archive_command until T-09.

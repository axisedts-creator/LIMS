# T-04 tests (tester)
- Static: `infra/tests/static/test_t04_postgres_image.py` (stdlib + jinja2). Classes: DockerfileTest, ConfTest, HbaTest, ConnectionMatrixTest (pg_hba first-match simulator over role x source x db).
- Live (CI only, `LIMS_T04_LIVE=1`, needs docker): `infra/tests/integration/test_t04_live.py` builds the image, sidecar psql from allowed vs foreign subnet, SHOW wal_level / log_parameter_max_length.
- Run: `.orchestra\notes\T-04-verify.cmd` (= `python -B -m unittest discover -s infra/tests/static -p "test_t04_*.py"`). Now: all fail, "missing file" (Dockerfile, zz-lims.conf.j2, pg_hba.conf.j2).
- CONTRACT: templates render with jinja2; allowed vars only: app_db_name, wg_ip (scalar), groups, hostvars[h].wg_ip, db_primary_wg_ip, docker_subnets.*, archive_timeout_s, inventory_hostname (else test fails with UNDEF<..>). Exactly one `host all all <bridge CIDR> scram-sha-256`; last two lines `host all all 0.0.0.0/0 reject` and `::/0 reject`; no hostssl.
- Dockerfile: final FROM `supabase/postgres@sha256:<64hex>`; no pgBackRest (T-09); config mounted, not COPYed.
- Covers AC-07.1 prerequisite, TRD s7.7, REQ-SEC-098. NOT provable here: real image start, real role passwords/init scripts (live test, CI). Ambiguity: TRD `app-1 all all` lets superuser in remotely; 07-SEC says local-only — not asserted.
- Review round 1: _ctx now uses groups/hostvars + scalar wg_ip; added dev case (groups['dr']=[] -> no dr lines, reject tail last). Fails until pg_hba.conf.j2 is fixed by writer (impl still uses wg_ip['app-1']).

# T-04 impl
- Files: infra/images/postgres-pgbackrest/Dockerfile, infra/database/postgresql/zz-lims.conf.j2, infra/database/postgresql/pg_hba.conf.j2.
- Base digest sha256:f371b5f3... = supabase/postgres:17.6.1.136 as recorded live in db/meta/decisions/SP-3.md (not re-resolved here; no network). Re-check against UPSTREAM.lock when T-05 lands.
- [CONV] pg_hba: local = image default (supabase_admin scram, others `peer map=supabase_map`); loopback 127.0.0.1/::1 scram (no trust); bridge = docker_subnets.db only; app-1 /32 all; dr-1 replication lims_replicator + {{ app_db_name }} lims_audit_ship; v4/v6 reject last; no ops-1.
- [CONV] zz-lims.conf: TRD s7.7 table verbatim; archive_command + hot_standby_feedback left out (T-09 / standby).
- Tests: static T-04 31/31 OK; all static 131 OK (3 skipped); live test skipped (LIMS_T04_LIVE unset, CI only). infra/tests/run.sh not run (approval denied).
- Open: archive_mode=on without archive_command until T-09 => WAL retained in pg_wal (disk growth) — do not run long-lived before T-09. Review fix: pg_hba uses hostvars[groups['app'/'dr'][0]].wg_ip (scalar per-host wg_ip, as inventories); dr lines guarded by `groups['dr']|length>0` (dev). pg_ident `supabase_map` + local scram for supabase_admin unverified until live run.

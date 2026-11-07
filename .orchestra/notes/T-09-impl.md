# T-09 impl (writer)
- Files: images/postgres-pgbackrest/Dockerfile; database/pgbackrest/pgbackrest.conf.j2; postgresql/zz-lims.conf.j2 (archive_command); roles/pgbackrest/** (tasks, cipher.conf tmpfs include, wrappers, backup/check scripts, 5 UTC timers); playbooks/site.yml; monitoring/textfile/pgbackrest_metrics.sh; compose/supabase/DECISION.md; secrets/schema/*.yaml (dr-1 not a repo2-pass consumer, AC-12.3).
- Post-ruling (LD-34/LD-43): no impl change needed; Dockerfile ARG PGBACKREST_TARBALL_SHA256 = real sha256sum of the 2.60.0 tarball (debugger round 1); DECISION.md lists check/full+incr/WAL-day as open (B12), no invented values.
- [CONV] passes via PGBACKREST_CONFIG_INCLUDE_PATH=/run/secrets/pgbackrest; counter in /var/lib/lims/pgbackrest; textfile dir /var/lib/node_exporter/textfile.
- Tests: T-09-verify.cmd -> 35 run, OK (skipped=1: WAL/day, B12). Full static suite: 7 fail + 2 error, all in T-01 lint/gitleaks + T-02 provider grep on compose/supabase/** (T-05) and T-20/T-21 promtool fixtures; none in T-09 paths.
- OPEN (B12): `pgbackrest check` both repos, first full+incr, measured WAL GiB/day on data-1/dr-1 (lean: prod-1/backup-1, LD-45). CR .orchestra/cr/T-09.md (AC-12.3 vs TRD s9.5) still open.
- OPEN for compose owner: mounts for pgbackrest.conf, repo1, PGBACKREST_CONFIG_INCLUDE_PATH. Gap: absent-metric alerts (T-18).

# Server-only tests: the one Nepal staging host

Topology: single host `staging-1`, inventory `infra/ansible/inventories/staging-lean` (groups data+app+ops; `dr` and `backup` empty), `LIMS_ENV=staging`, synthetic data only (CR `.orchestra/cr/NEPAL-single-host.md`). These checks need the real host (wg0, LUKS, NVMe, public DNS and TLS, Docker stack), so none of them can run in the cloud container. Script: `infra/cutover/server-smoke.sh` (T-30/T-31 subset); it reuses the kit's checks and reimplements none.

## Before you run

On `staging-1`, as root, in a checkout of this repo, with the stack deployed (`site.yml` + `deploy.yml`) and a first pgBackRest backup taken. Install: `apt-get install -y fio jq postgresql-client wireguard-tools cryptsetup python3-yaml`, plus `testssl.sh` (set `TESTSSL` if it is not on PATH).

```bash
export LIMS_ENV=staging                                   # required; the script exits 2 for anything else
export LIMS_INVENTORY_DIR=infra/ansible/inventories/staging-lean   # default; any other dir exits 2
export LIMS_ORIGIN_STAFF_WEB=... LIMS_ORIGIN_PORTAL=... LIMS_ORIGIN_API=...   # host names (tls.sh, ratelimit.py, run.sh all)
export LIMS_EDGE_ADDR=...                                 # optional connect IP (SNI stays the origin name)
export LIMS_TLS_CA=/path/ca.pem                           # or LIMS_TLS_INSECURE=1 (internal CA); LIMS_TLS_REPORT_DIR, TESTSSL optional
export LIMS_TEST_SOURCE_IPS=ip1,ip2,...                   # ratelimit.py: one local source IP per scenario, or LIMS_RATELIMIT_JAIL_OFF=1
export LIMS_PGBOUNCER_ADMIN_URL=postgresql://pgbouncer@127.0.0.1:6432/pgbouncer   # [CONV] new name; password via PGPASSWORD/.pgpass, never in the repo
export DATA_WG_IP=... SMTP_RELAY_HOST=...                 # egress_probe.sh auth (staging: Mailpit, see deploy.yml)
export PROXY_ALLOWED_FQDN=... PROXY_DENIED_FQDN=...       # egress_probe.sh proxy
export LIMS_EGRESS_DB_CONTAINERS="..." LIMS_EGRESS_EDGE_CONTAINERS="..." LIMS_EGRESS_PROXY_CONTAINERS="..."   # space lists
export LIMS_PUBLIC_IFACE=... LIMS_WG_IP=10.78.0.11 LIMS_PUBLIC_IP=... LIMS_COMPOSE_CONFIGS="..." LIMS_SECRETS_VALUES=...   # run.sh all (see its header)
export LIMS_CLAMD_CONTAINER=... LIMS_APP_DB_URL=... LIMS_AUDIT_DB_URL=...                                                  # run.sh all
# optional [CONV]: LIMS_DB_MOUNT (/srv/lims/db) LIMS_MIN_IOPS (10000) PGBACKREST LIMS_PGBOUNCER_INI
#                  LIMS_DRILL_CONTAINER (drill-pg) LIMS_DRILL_REPO (1) DRILL_TARGET_OFFSET_MIN (30) DRILL_ACCEPT_TIMEOUT_S (7200) DRILL_PG_CONFIG_FILE
bash infra/cutover/server-smoke.sh --dry-run              # prints every check and command; executes nothing
bash infra/cutover/server-smoke.sh                        # all checks; exit code = number of FAILs
bash infra/cutover/server-smoke.sh --only wal-archive     # one check
```

Output: `PASS <id>`, `FAIL <id> <reason>` or `SKIP <id> <reason>` per check, plus `INFO` lines (iops, rto_seconds). A missing tool is a FAIL with an install hint. `restore-drill` and `disk-iops` change the host (scratch restore, 2 GiB temp file under the db mount, removed again); run them in a quiet window. The restore needs the scratch container `drill-pg` (see "restore-drill" below).

## Checks

| id | what it proves | exact command | expected output | spec cite | why not in the cloud container |
|---|---|---|---|---|---|
| tls-chain | every public origin: TLS 1.2/1.3 only, the six allowed TLS 1.2 suites, cert chain valid, lifetime <= 90 d | `bash infra/tests/external/tls.sh` | `PASS tls-chain` | C1 06-PLAN T-30; AC-02.1, AC-02.2; 04 I5 | needs the real public DNS names, the edge nginx and the issued certificates |
| wg-up | `wg0` exists, flag UP, listed by `wg show wg0` | `ip -o link show wg0`; `wg show wg0` | `PASS wg-up` | 02-TRD s3.2 (wg0 overlay); T-31 | no WireGuard kernel interface in the container |
| wg-mesh-peers | mesh peers reachable | not run | `SKIP wg-mesh-peers single host: no mesh peers (CR NEPAL-single-host)` | CR NEPAL-single-host; 04 S1 | n/a on one host (re-enable with the 2-host profile) |
| luks-mounts | each disk in `hosts.yml` `disks:` has mapping `luks_<key>` of type LUKS on that disk and is mounted at `/srv/lims/<key>` on dm-crypt | `cryptsetup status luks_<key>`; `findmnt -n -o SOURCE /srv/lims/<key>`; `lsblk -s -n -o TYPE <source>` (per disk) | `PASS luks-mounts` | 07-SEC control 2; role `luks_volumes`; 04 I1 | needs the real block devices and device-mapper |
| disk-iops | the db volume meets the NVMe figure: fio 4k randrw (70/30), 60 s, direct, 4 jobs x 512 MiB, read+write IOPS >= 10000 | `fio --name=lims-smoke --directory=<tmp under /srv/lims/db> --rw=randrw --rwmixread=70 --bs=4k --direct=1 --ioengine=libaio --iodepth=32 --numjobs=4 --size=512m --runtime=60 --time_based --group_reporting --output-format=json` | `INFO disk-iops iops=<n> ...` then `PASS disk-iops`; temp dir removed | 04 I1 (NVMe >=10k IOPS) | measures the server's own disk |
| pgbouncer-config | live `SHOW CONFIG` equals the kit file: pool_mode, max_client_conn, default_pool_size, reserve_pool_size, reserve_pool_timeout, max_prepared_statements, auth_type, query_wait_timeout, server_idle_timeout, server_lifetime, idle_transaction_timeout | `psql "$LIMS_PGBOUNCER_ADMIN_URL" -X -At -F '\|' -c 'SHOW CONFIG'` vs `infra/database/pgbouncer/pgbouncer.ini.j2` | `PASS pgbouncer-config`; on drift `FAIL ... key(kit=a live=b)` | 02-TRD s7.6; 04 S8 (transaction mode) | needs the running pgbouncer container |
| wal-archive | WAL archiving works and repo1 holds >= 1 backup (stanza and repo1 status ok) | `/usr/local/lib/lims/bin/pgbackrest --stanza=lims check`; `... --stanza=lims --repo=1 --output=json info` | `PASS wal-archive` | 02-TRD s9.3/s9.4; AC-12.1..12.4; 04 I3 | needs the live Postgres and the repo1 volume |
| wal-archive-repo2 | site-B WAL archive | not run | `SKIP wal-archive-repo2 single host: no site B (CR NEPAL-single-host)` | CR NEPAL-single-host; 04 S1, LD-45 | n/a on one host: staging only, never PHI. Prod needs `backup-1` (B12) |
| restore-drill | a PITR restore (now - 30 min) from repo1 into the scratch container starts and accepts connections; reports measured RTO | `infra/drill/restore.sh` copied unmodified into `drill-pg`; `docker exec --env=DRILL_REPO=1 --env=PGDATA=/var/lib/postgresql/data --env=DRILL_TARGET_OFFSET_MIN=30 --env=DRILL_ACCEPT_TIMEOUT_S=7200 --env=DRILL_PG_CONFIG_FILE=/etc/postgresql/postgresql.conf drill-pg bash /tmp/restore-smoke.sh` | `INFO restore-drill rto_seconds=<n> target_time=... repo=1` then `PASS restore-drill` | 04 I3 (monthly, timed, RTO documented); 02-TRD s9.6; AC-13.1..13.3; `infra/drill/README.md` | needs a real pgBackRest repo, the db image and root on the host |
| standby | hot standby lag | not run | `SKIP standby single host: dr group empty, no standby (CR NEPAL-single-host)` | CR NEPAL-single-host; 02-TRD s9.5 | n/a on one host |
| egress-deny | containers reach only their allowlist: auth -> data wg IP :5432 and the relay :587; db/edge/proxy members per `egress_probe.sh` | `bash infra/tests/internal/egress_probe.sh auth`; `... db\|edge\|proxy <container>` for each name in `LIMS_EGRESS_{DB,EDGE,PROXY}_CONTAINERS` | `PASS egress-deny` (an empty container list = FAIL, as in `run.sh all`) | AC-09.3; 07-SEC; 04 I7 (no foreign egress) | needs the running containers and the host nftables/DOCKER-USER rules |
| login-ratelimit | edge limits, incl. `POST /auth/login`, 413 limits, `@ratelimited` Retry-After | `python3 infra/tests/external/ratelimit.py` | `PASS login-ratelimit` | AC-04.1..04.10; 02-TRD s6.5; 04 I7 (local mitigation) | needs the live edge and a real public vantage |
| run-sh-all | the whole kit suite (static + every external and internal live check) is green | `bash infra/tests/run.sh all` | `PASS run-sh-all` (last lines of run.sh: all `ok -`) | C1 06-PLAN T-30 (`run.sh` all green on staging); AC-01.1..01.4 | needs the deployed environment |

## restore-drill: prerequisite on this host

`infra/ansible/playbooks/restore-drill.yml` asserts a non-empty `dr` group, so it cannot run on `staging-lean`. `infra/drill/restore.sh` now reads `DRILL_REPO` (1 or 2, default 2; lean = 1). The smoke check expects the scratch container `drill-pg` already running, built as the playbook does (empty PGDATA volume at `/var/lib/postgresql/data`, `pgbackrest.conf` for stanza `lims` with the repo1 cipher include on tmpfs, no published port), copies `restore.sh` into it and runs it with `DRILL_REPO=$LIMS_DRILL_REPO` (default 1). A lean branch in the playbook is still open (C1 owner); see `infra/cutover/notes/N2.md`. The drill on this host restores from the same disk it protects, so it proves the procedure and the RTO, not site-loss survival.

#!/usr/bin/env bash
# infra/cutover/server-smoke.sh - server-only checks for the ONE Nepal staging host (slice N2, C1 T-30/T-31 subset).
# Topology: single host `staging-1`, inventory infra/ansible/inventories/staging-lean (groups data+app+ops, dr/backup empty),
# synthetic data only (CR NEPAL-single-host). Runs ON staging-1 as root, from a checkout of this repo.
#
#   server-smoke.sh [--dry-run] [--only <id>]
#   --dry-run   print every check and every command it would run; execute nothing, touch nothing (no root needed)
#   --only <id> run one check (ids: see CHECKS below)
# Output: one line per check: `PASS <id>` | `FAIL <id> <reason>` | `SKIP <id> <reason>`. Extra `INFO` lines carry measurements
# (iops, rto_seconds). Secret values and database URLs are never printed. Exit code = number of FAILed checks (0 = all PASS);
# 2 = refused (wrong env/inventory/not root/usage), nothing was run.
# Reuses the kit's live checks (infra/tests/run.sh, external/*, internal/*, drill/restore.sh); nothing is reimplemented.
# A missing tool (fio, jq, psql, pgbackrest, wg, ...) is a FAIL with an install hint, never a silent pass.
#
# Env (names copied from the kit scripts; see infra/cutover/SERVER-TESTS.md):
#   LIMS_ENV=staging (required)   LIMS_INVENTORY_DIR (default infra/ansible/inventories/staging-lean)
#   LIMS_ORIGIN_STAFF_WEB LIMS_ORIGIN_PORTAL LIMS_ORIGIN_API  LIMS_EDGE_ADDR  LIMS_TLS_CA|LIMS_TLS_INSECURE  TESTSSL  (tls.sh, ratelimit.py)
#   LIMS_TEST_SOURCE_IPS | LIMS_RATELIMIT_JAIL_OFF=1                                              (ratelimit.py)
#   LIMS_PGBOUNCER_ADMIN_URL   libpq URL of the PgBouncer admin console (user `pgbouncer`)        [CONV] new name
#   LIMS_PGBOUNCER_INI         kit config to compare with (default infra/database/pgbouncer/pgbouncer.ini.j2)
#   LIMS_DB_MOUNT (default /srv/lims/db)  LIMS_MIN_IOPS (default 10000, 04 I1)                      [CONV] new names
#   PGBACKREST (default /usr/local/lib/lims/bin/pgbackrest, as lims-pgbackrest-check.sh)
#   LIMS_DRILL_CONTAINER (default drill-pg)  LIMS_DRILL_REPO (default 1; read by drill/restore.sh)  DRILL_TARGET_OFFSET_MIN  DRILL_ACCEPT_TIMEOUT_S  [CONV]
#   DATA_WG_IP SMTP_RELAY_HOST PROXY_ALLOWED_FQDN PROXY_DENIED_FQDN LIMS_EGRESS_{DB,EDGE,PROXY}_CONTAINERS   (egress_probe.sh)
#   everything run.sh all reads (LIMS_PUBLIC_IFACE, LIMS_WG_IP, LIMS_COMPOSE_CONFIGS, LIMS_SECRETS_VALUES, ...)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT=$PWD

CHECKS="tls-chain wg-up wg-mesh-peers luks-mounts disk-iops pgbouncer-config wal-archive wal-archive-repo2 restore-drill standby egress-deny login-ratelimit run-sh-all"

DRY=0
ONLY=""
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1; shift ;;
    --only)
      [ $# -ge 2 ] || { echo "usage: server-smoke.sh [--dry-run] [--only <id>]" >&2; exit 2; }
      ONLY=$2; shift 2 ;;
    *) echo "usage: server-smoke.sh [--dry-run] [--only <id>]  (unknown argument '$1')" >&2; exit 2 ;;
  esac
done
if [ -n "$ONLY" ]; then
  case " $CHECKS " in *" $ONLY "*) ;; *) echo "server-smoke.sh: unknown check id '$ONLY' (ids: $CHECKS)" >&2; exit 2 ;; esac
fi

# ---- refuse unless this is the single staging host (CR NEPAL-single-host); applies to --dry-run too ----
[ "${LIMS_ENV:-}" = staging ] || { echo "server-smoke.sh: refused: set LIMS_ENV=staging (got '${LIMS_ENV:-}')" >&2; exit 2; }
INV=${LIMS_INVENTORY_DIR:-infra/ansible/inventories/staging-lean}
INV_REAL=$(realpath -m "$INV")
if [ "$(basename "$INV_REAL")" != staging-lean ] || [ "$(basename "$(dirname "$INV_REAL")")" != inventories ] \
  || [ ! -f "$INV_REAL/hosts.yml" ]; then
  echo "server-smoke.sh: refused: inventory must be .../inventories/staging-lean with a hosts.yml (got '$INV')" >&2; exit 2
fi
if ! grep -Eq '^[[:space:]]+dr: \{\}' "$INV_REAL/hosts.yml" || ! grep -Eq '^[[:space:]]+backup: \{\}' "$INV_REAL/hosts.yml"; then
  echo "server-smoke.sh: refused: groups dr and backup must be empty ({}) in $INV_REAL/hosts.yml (single host)" >&2; exit 2
fi
if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "server-smoke.sh: refused: run as root on staging-1 (or use --dry-run)" >&2; exit 2
fi
export LIMS_ENV LIMS_INVENTORY_DIR="$INV_REAL"

# ---- defaults ----
DB_MOUNT=${LIMS_DB_MOUNT:-/srv/lims/db}
MIN_IOPS=${LIMS_MIN_IOPS:-10000}
PGBR=${PGBACKREST:-/usr/local/lib/lims/bin/pgbackrest}
PGB_INI=${LIMS_PGBOUNCER_INI:-infra/database/pgbouncer/pgbouncer.ini.j2}
DRILL_C=${LIMS_DRILL_CONTAINER:-drill-pg}
DRILL_REPO=${LIMS_DRILL_REPO:-1}
DRILL_LOCK=/var/lock/lims-drill
EXT=infra/tests/external
INT=infra/tests/internal

FAILS=0
TMP=""
# shellcheck disable=SC2329 # invoked via trap
cleanup() {
  [ -z "$TMP" ] || rm -rf "$TMP"
  [ -z "${IOPS_DIR:-}" ] || rm -rf "$IOPS_DIR"
  [ -z "${LOCK_HELD:-}" ] || rm -f "$DRILL_LOCK"
}
trap cleanup EXIT

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1 $2"; FAILS=$((FAILS + 1)); }
skip() { echo "SKIP $1 $2"; }
# dry-run printers
desc() { [ "$DRY" -eq 0 ] || echo "CHECK $1: $2"; }
plan() { [ "$DRY" -eq 0 ] || echo "  + $*"; }
# one line, no control chars, URLs redacted, <= 200 chars
clean() { tr -d '\000-\010\013-\037' | tr '\n' ' ' | sed -E 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]+#<url>#g' | cut -c1-200; }
lastline() { grep -v '^[[:space:]]*$' "$1" 2>/dev/null | tail -n 1 | clean || true; }
# need ID TOOL HINT: FAIL (and return 1) when TOOL is missing
need() {
  command -v "$2" >/dev/null 2>&1 && return 0
  fail "$1" "tool '$2' missing: $3"
  return 1
}
# runlog ID NAME CMD...: run CMD, output to $TMP/ID-NAME.log, return its exit code (output is never echoed)
runlog() {
  local id=$1 name=$2; shift 2
  "$@" >"$TMP/$id-$name.log" 2>&1
}
# verdict ID NAME RC: PASS on 0, else FAIL with exit code + last output line
verdict() {
  if [ "$3" -eq 0 ]; then pass "$1"; else fail "$1" "$2 rc=$3: $(lastline "$TMP/$1-$2.log")"; fi
}

# ---------------------------------------------------------------- checks
chk_tls_chain() { # AC-02.1 / AC-02.2, 04 I5/I7
  local id=tls-chain rc=0
  desc $id "TLS chain/protocols/ciphers on the public origins (wraps $EXT/tls.sh)"
  plan "bash $EXT/tls.sh"
  [ "$DRY" -eq 0 ] || return 0
  need $id openssl "apt-get install -y openssl" || return 0
  runlog $id tls bash "$EXT/tls.sh" || rc=$?
  verdict $id tls "$rc"
}

chk_wg_up() { # 02-TRD s3.2: wg0 overlay
  local id=wg-up rc=0
  desc $id "wg0 interface is up and known to wireguard"
  plan "ip -o link show wg0   (flags must contain UP)"
  plan "wg show wg0   (must print 'interface: wg0')"
  [ "$DRY" -eq 0 ] || return 0
  need $id wg "apt-get install -y wireguard-tools" || return 0
  need $id ip "apt-get install -y iproute2" || return 0
  runlog $id link ip -o link show wg0 || rc=$?
  if [ "$rc" -ne 0 ]; then fail $id "no wg0 interface (systemctl status wg-quick@wg0)"; return 0; fi
  if ! grep -Eq '<[^>]*\bUP\b[^>]*>' "$TMP/$id-link.log"; then fail $id "wg0 exists but is not UP (systemctl start wg-quick@wg0)"; return 0; fi
  rc=0; runlog $id show wg show wg0 || rc=$?
  if [ "$rc" -ne 0 ] || ! grep -q '^interface: wg0' "$TMP/$id-show.log"; then fail $id "wg show wg0 does not list the interface"; return 0; fi
  pass $id
}

chk_wg_mesh_peers() {
  desc wg-mesh-peers "mesh peers (none expected on one host)"
  plan "(not run)"
  [ "$DRY" -eq 0 ] || return 0
  skip wg-mesh-peers "single host: no mesh peers (CR NEPAL-single-host)"
}

# print "<key> <dev>" for every entry under `disks:` in hosts.yml (the only data source for the disk list)
disk_list() {
  python3 -I -c '
import sys, yaml
inv = yaml.safe_load(open(sys.argv[1]))
seen = {}
def walk(n):
    if isinstance(n, dict):
        for k, v in n.items():
            if k == "disks" and isinstance(v, dict):
                seen.update(v)
            else:
                walk(v)
walk(inv)
for k, v in seen.items():
    print(k, v)
' "$INV_REAL/hosts.yml"
}

chk_luks_mounts() { # 07-SEC control 2, AC-14.x: dm-crypt under every data disk, mounted at /srv/lims/<key>
  local id=luks-mounts key dev name mnt src real bad="" n=0
  desc $id "every disk in hosts.yml 'disks:' is a LUKS mapping luks_<key> and is mounted at /srv/lims/<key>"
  plan "python3 -I (yaml) -> list disks from $INV_REAL/hosts.yml"
  plan "cryptsetup status luks_<key>   (type LUKS, device = realpath of the by-id disk)"
  plan "findmnt -n -o SOURCE /srv/lims/<key> ; lsblk -s -n -o TYPE <source>   (must include 'crypt')"
  [ "$DRY" -eq 0 ] || return 0
  need $id cryptsetup "apt-get install -y cryptsetup" || return 0
  need $id lsblk "apt-get install -y util-linux" || return 0
  need $id findmnt "apt-get install -y util-linux" || return 0
  need $id python3 "apt-get install -y python3 python3-yaml" || return 0
  python3 -I -c 'import yaml' 2>/dev/null || { fail $id "python3 yaml missing: apt-get install -y python3-yaml"; return 0; }
  disk_list >"$TMP/$id-disks.txt" 2>"$TMP/$id-err.log" || { fail $id "cannot read disks from hosts.yml: $(lastline "$TMP/$id-err.log")"; return 0; }
  while read -r key dev; do
    [ -n "$key" ] || continue
    n=$((n + 1))
    name=luks_$key; mnt=/srv/lims/$key
    if ! cryptsetup status "$name" >"$TMP/$id-st.log" 2>&1; then bad="$bad $key(no mapping $name)"; continue; fi
    grep -Eiq '^[[:space:]]*type:[[:space:]]+LUKS' "$TMP/$id-st.log" || { bad="$bad $key(mapping is not LUKS)"; continue; }
    real=$(realpath -e "$dev" 2>/dev/null || true)
    if [ -z "$real" ]; then bad="$bad $key(disk path in hosts.yml missing: placeholder not replaced?)"; continue; fi
    grep -Eq "^[[:space:]]*device:[[:space:]]+$real\$" "$TMP/$id-st.log" || { bad="$bad $key(mapping not on $real)"; continue; }
    src=$(findmnt -n -o SOURCE "$mnt" 2>/dev/null || true)
    [ -n "$src" ] || { bad="$bad $key(not mounted at $mnt)"; continue; }
    lsblk -s -n -o TYPE "$src" 2>/dev/null | grep -qx crypt || bad="$bad $key($mnt not on dm-crypt)"
  done <"$TMP/$id-disks.txt"
  if [ "$n" -eq 0 ]; then fail $id "no disks: entries found in hosts.yml"; return 0; fi
  if [ -n "$bad" ]; then fail $id "$bad" ; else pass $id; fi
}

chk_disk_iops() { # 04 I1: NVMe >= 10k IOPS
  local id=disk-iops iops rc=0
  desc $id "fio 4k randrw 60 s on the db mount ($DB_MOUNT) >= $MIN_IOPS IOPS (04 I1); temp file removed"
  plan "mountpoint -q $DB_MOUNT"
  plan "fio --name=lims-smoke --directory=<tmpdir under $DB_MOUNT> --rw=randrw --rwmixread=70 --bs=4k --direct=1 --ioengine=libaio --iodepth=32 --numjobs=4 --size=512m --runtime=60 --time_based --group_reporting --output-format=json"
  plan "jq: read.iops + write.iops >= $MIN_IOPS ; rm -rf <tmpdir>"
  [ "$DRY" -eq 0 ] || return 0
  need $id fio "apt-get install -y fio" || return 0
  need $id jq "apt-get install -y jq" || return 0
  mountpoint -q "$DB_MOUNT" || { fail $id "$DB_MOUNT is not a mount point (set LIMS_DB_MOUNT)"; return 0; }
  IOPS_DIR=$(mktemp -d -p "$DB_MOUNT" .lims-smoke-iops.XXXXXX) || { fail $id "cannot create a temp dir under $DB_MOUNT"; return 0; }
  fio --name=lims-smoke --directory="$IOPS_DIR" --rw=randrw --rwmixread=70 --bs=4k --direct=1 --ioengine=libaio \
    --iodepth=32 --numjobs=4 --size=512m --runtime=60 --time_based --group_reporting --output-format=json \
    >"$TMP/$id-fio.json" 2>"$TMP/$id-fio.err" || rc=$?
  rm -rf "$IOPS_DIR"; IOPS_DIR=""
  if [ "$rc" -ne 0 ]; then fail $id "fio rc=$rc: $(lastline "$TMP/$id-fio.err")"; return 0; fi
  iops=$(jq -r '[.jobs[] | (.read.iops + .write.iops)] | add | floor' "$TMP/$id-fio.json" 2>/dev/null || true)
  case $iops in '' | *[!0-9]*) fail $id "cannot read iops from fio output"; return 0 ;; esac
  echo "INFO $id iops=$iops min=$MIN_IOPS mount=$DB_MOUNT"
  if [ "$iops" -ge "$MIN_IOPS" ]; then pass $id; else fail $id "iops=$iops < $MIN_IOPS (04 I1 NVMe >=10k)"; fi
}

chk_pgbouncer_config() { # 02-TRD s7.6, 04 S8: effective config = the kit's file
  local id=pgbouncer-config key exp act bad="" keys
  keys="pool_mode max_client_conn default_pool_size reserve_pool_size reserve_pool_timeout max_prepared_statements auth_type query_wait_timeout server_idle_timeout server_lifetime idle_transaction_timeout"
  desc $id "SHOW CONFIG on the PgBouncer admin console equals the values in $PGB_INI"
  plan "psql \"\$LIMS_PGBOUNCER_ADMIN_URL\" -X -At -F '|' -c 'SHOW CONFIG'   (URL never printed)"
  plan "compare with [pgbouncer] section of $PGB_INI: $keys"
  [ "$DRY" -eq 0 ] || return 0
  need $id psql "apt-get install -y postgresql-client" || return 0
  [ -f "$PGB_INI" ] || { fail $id "kit config $PGB_INI not found"; return 0; }
  [ -n "${LIMS_PGBOUNCER_ADMIN_URL:-}" ] || { fail $id "LIMS_PGBOUNCER_ADMIN_URL is not set (admin console URL, user pgbouncer)"; return 0; }
  if ! psql "$LIMS_PGBOUNCER_ADMIN_URL" -X -At -F '|' -c 'SHOW CONFIG' >"$TMP/$id-cfg.txt" 2>"$TMP/$id-err.log"; then
    fail $id "SHOW CONFIG failed: $(lastline "$TMP/$id-err.log")"; return 0
  fi
  for key in $keys; do
    exp=$(sed -n '/^\[pgbouncer\]/,/^\[/p' "$PGB_INI" | awk -F' *= *' -v k="$key" '$1 == k { print $2; exit }')
    act=$(awk -F'|' -v k="$key" '$1 == k { print $2; exit }' "$TMP/$id-cfg.txt")
    if [ -z "$exp" ]; then bad="$bad $key(not in kit ini)"
    elif [ "$exp" != "$act" ]; then bad="$bad $key(kit=$exp live=${act:-unset})"; fi
  done
  if [ -n "$bad" ]; then fail $id "$bad"; else pass $id; fi
}

chk_wal_archive() { # 02-TRD s9.3/s9.4 AC-12.x: repo1 only on this host
  local id=wal-archive rc=0
  desc $id "pgBackRest stanza lims: archive check + repo1 healthy with >= 1 backup"
  plan "$PGBR --stanza=lims check"
  plan "$PGBR --stanza=lims --repo=1 --output=json info   (stanza status ok, repo1 ok, >= 1 backup)"
  [ "$DRY" -eq 0 ] || return 0
  [ -x "$PGBR" ] || { fail $id "pgbackrest wrapper $PGBR missing: run the pgbackrest role (site.yml) or set PGBACKREST"; return 0; }
  need $id docker "apt-get install -y docker-ce (role docker_engine)" || return 0
  need $id jq "apt-get install -y jq" || return 0
  runlog $id check "$PGBR" --stanza=lims check || rc=$?
  if [ "$rc" -ne 0 ]; then verdict $id check "$rc"; return 0; fi
  rc=0
  "$PGBR" --stanza=lims --repo=1 --output=json info >"$TMP/$id-info.json" 2>"$TMP/$id-info.err" || rc=$?
  if [ "$rc" -ne 0 ]; then fail $id "info rc=$rc: $(lastline "$TMP/$id-info.err")"; return 0; fi
  if jq -e '.[] | select(.name == "lims") | (.status.code == 0) and ([.repo[]? | select(.key == 1) | .status.code] == [0]) and ((.backup | length) >= 1)' \
    "$TMP/$id-info.json" >/dev/null 2>&1; then pass $id; else fail $id "stanza lims or repo1 not ok, or no backup yet (pgbackrest --stanza=lims info)"; fi
}

chk_wal_archive_repo2() {
  desc wal-archive-repo2 "repo2 (site B) WAL archive"
  plan "(not run)"
  [ "$DRY" -eq 0 ] || return 0
  skip wal-archive-repo2 "single host: no site B (CR NEPAL-single-host)"
}

chk_restore_drill() { # 04 I3, 02-TRD s9.6, AC-13.x: timed restore, measured RTO
  local id=restore-drill rc=0 script=infra/drill/restore.sh rto="" target=""
  desc $id "PITR restore of repo$DRILL_REPO into scratch container $DRILL_C via $script, measured RTO (04 I3)"
  plan "test ! -e $DRILL_LOCK ; touch $DRILL_LOCK   (drill lock, 03-APP-FLOW s4.1; removed on exit)"
  plan "docker inspect -f '{{.State.Running}}' $DRILL_C   (scratch container, drill README)"
  plan "docker cp $script $DRILL_C:/tmp/restore-smoke.sh   (unmodified kit script)"
  plan "docker exec --env=DRILL_REPO=$DRILL_REPO --env=PGDATA=/var/lib/postgresql/data --env=DRILL_TARGET_OFFSET_MIN=\${DRILL_TARGET_OFFSET_MIN:-30} --env=DRILL_ACCEPT_TIMEOUT_S=\${DRILL_ACCEPT_TIMEOUT_S:-7200} --env=DRILL_PG_CONFIG_FILE=\${DRILL_PG_CONFIG_FILE:-/etc/postgresql/postgresql.conf} $DRILL_C bash /tmp/restore-smoke.sh"
  plan "parse rto_seconds= from stdout ; docker exec $DRILL_C rm -f /tmp/restore-smoke.sh"
  [ "$DRY" -eq 0 ] || return 0
  need $id docker "apt-get install -y docker-ce (role docker_engine)" || return 0
  [[ $DRILL_REPO =~ ^[12]$ ]] || { fail $id "LIMS_DRILL_REPO must be 1 or 2"; return 0; }
  [ -f "$script" ] || { fail $id "$script missing"; return 0; }
  if [ "$(docker inspect -f '{{.State.Running}}' "$DRILL_C" 2>/dev/null || true)" != true ]; then
    fail $id "scratch container $DRILL_C not running: restore-drill.yml needs a dr host (lean has none); create it as in infra/drill/README.md (empty PGDATA volume, pgbackrest conf for repo$DRILL_REPO) or set LIMS_DRILL_CONTAINER"
    return 0
  fi
  [ ! -e "$DRILL_LOCK" ] || { fail $id "$DRILL_LOCK exists: another drill is running or stale (check, remove by hand)"; return 0; }
  printf 'server-smoke %s\n' "$(date -u +%FT%TZ)" >"$DRILL_LOCK"; LOCK_HELD=1
  docker cp "$script" "$DRILL_C:/tmp/restore-smoke.sh" >"$TMP/$id-cp.log" 2>&1 || { fail $id "docker cp failed: $(lastline "$TMP/$id-cp.log")"; return 0; }
  docker exec --env="DRILL_REPO=$DRILL_REPO" --env=PGDATA=/var/lib/postgresql/data \
    --env="DRILL_TARGET_OFFSET_MIN=${DRILL_TARGET_OFFSET_MIN:-30}" \
    --env="DRILL_ACCEPT_TIMEOUT_S=${DRILL_ACCEPT_TIMEOUT_S:-7200}" \
    --env="DRILL_PG_CONFIG_FILE=${DRILL_PG_CONFIG_FILE:-/etc/postgresql/postgresql.conf}" \
    "$DRILL_C" bash /tmp/restore-smoke.sh >"$TMP/$id-out.log" 2>"$TMP/$id-err.log" || rc=$?
  docker exec "$DRILL_C" rm -f /tmp/restore-smoke.sh >/dev/null 2>&1 || true
  rm -f "$DRILL_LOCK"; LOCK_HELD=""
  target=$(sed -n 's/^target_time=//p' "$TMP/$id-out.log" | head -n 1 | clean || true)
  rto=$(sed -n 's/^rto_seconds=\([0-9]*\)$/\1/p' "$TMP/$id-out.log" | head -n 1)
  if [ "$rc" -ne 0 ]; then fail $id "restore.sh rc=$rc: $(lastline "$TMP/$id-err.log")"; return 0; fi
  [ -n "$rto" ] || { fail $id "restore.sh gave no rto_seconds"; return 0; }
  echo "INFO $id rto_seconds=$rto target_time=$target repo=$DRILL_REPO"
  pass $id
}

chk_standby() {
  desc standby "hot standby / replication lag"
  plan "(not run)"
  [ "$DRY" -eq 0 ] || return 0
  skip standby "single host: dr group empty, no standby (CR NEPAL-single-host)"
}

chk_egress_deny() { # AC-09.3, 07-SEC egress allowlist
  local id=egress-deny bad="" rc m c var list
  desc $id "containers cannot reach anything but their allowlist (wraps $INT/egress_probe.sh)"
  plan "bash $INT/egress_probe.sh auth"
  plan "for each c in \$LIMS_EGRESS_{DB,EDGE,PROXY}_CONTAINERS: bash $INT/egress_probe.sh db|edge|proxy <c>"
  [ "$DRY" -eq 0 ] || return 0
  need $id docker "apt-get install -y docker-ce (role docker_engine)" || return 0
  rc=0; runlog $id auth bash "$INT/egress_probe.sh" auth || rc=$?
  [ "$rc" -eq 0 ] || bad="$bad auth(rc=$rc: $(lastline "$TMP/$id-auth.log"))"
  for m in db edge proxy; do
    var=LIMS_EGRESS_$(printf '%s' "$m" | tr '[:lower:]' '[:upper:]')_CONTAINERS
    list=${!var:-}
    if [ -z "$list" ]; then bad="$bad $m($var empty)"; continue; fi
    for c in $list; do
      rc=0; runlog $id "$m-$c" bash "$INT/egress_probe.sh" "$m" "$c" || rc=$?
      [ "$rc" -eq 0 ] || bad="$bad $m/$c(rc=$rc: $(lastline "$TMP/$id-$m-$c.log"))"
    done
  done
  if [ -n "$bad" ]; then fail $id "$bad"; else pass $id; fi
}

chk_login_ratelimit() { # AC-04.1..04.10
  local id=login-ratelimit rc=0
  desc $id "edge rate limits incl. POST /auth/login (wraps $EXT/ratelimit.py)"
  plan "python3 $EXT/ratelimit.py"
  [ "$DRY" -eq 0 ] || return 0
  need $id python3 "apt-get install -y python3" || return 0
  runlog $id rl python3 "$EXT/ratelimit.py" || rc=$?
  verdict $id rl "$rc"
}

chk_run_sh_all() { # T-30: the whole kit suite
  local id=run-sh-all rc=0
  desc $id "the kit's full live suite (wraps infra/tests/run.sh all)"
  plan "bash infra/tests/run.sh all"
  [ "$DRY" -eq 0 ] || return 0
  runlog $id all bash infra/tests/run.sh all || rc=$?
  if [ "$rc" -eq 0 ]; then pass $id; else fail $id "run.sh all rc=$rc: $(grep -h '^not ok' "$TMP/$id-all.log" | head -n 5 | clean || true)"; fi
}

# ---------------------------------------------------------------- main
echo "server-smoke: env=$LIMS_ENV inventory=$INV_REAL root=$ROOT mode=$([ "$DRY" -eq 1 ] && echo dry-run || echo run)"
if [ "$DRY" -eq 0 ]; then
  echo "server-smoke: will run on this host: ${ONLY:-$CHECKS}"
  echo "server-smoke: side effects: fio writes a temp file under $DB_MOUNT (removed); restore-drill takes $DRILL_LOCK and restores into $DRILL_C"
  TMP=$(mktemp -d)
fi

for id in $CHECKS; do
  [ -z "$ONLY" ] || [ "$ONLY" = "$id" ] || continue
  case $id in
    tls-chain) chk_tls_chain ;;
    wg-up) chk_wg_up ;;
    wg-mesh-peers) chk_wg_mesh_peers ;;
    luks-mounts) chk_luks_mounts ;;
    disk-iops) chk_disk_iops ;;
    pgbouncer-config) chk_pgbouncer_config ;;
    wal-archive) chk_wal_archive ;;
    wal-archive-repo2) chk_wal_archive_repo2 ;;
    restore-drill) chk_restore_drill ;;
    standby) chk_standby ;;
    egress-deny) chk_egress_deny ;;
    login-ratelimit) chk_login_ratelimit ;;
    run-sh-all) chk_run_sh_all ;;
  esac
done

[ "$DRY" -eq 0 ] || { echo "server-smoke: dry-run complete, nothing executed"; exit 0; }
echo "server-smoke: $FAILS check(s) FAILed"
[ "$FAILS" -le 255 ] || FAILS=255
exit "$FAILS"

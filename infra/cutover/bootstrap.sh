#!/usr/bin/env bash
# infra/cutover/bootstrap.sh - one-command builder for the ONE Nepal staging server (slice N6, C1).
# Topology: single host `staging-1`, inventory infra/ansible/inventories/staging-lean (groups data+app+ops, dr/backup
# empty), LIMS_ENV=staging, synthetic data only (CR .orchestra/cr/NEPAL-single-host.md). Runs ON the server as root,
# from a checkout of this repo. It ORCHESTRATES the existing kit (site.yml, db-bootstrap.yml, infra/ci/deploy.sh,
# infra/ci/rollback.sh, role secrets_render tasks_from generate); it reimplements no role.
#
#   bootstrap.sh [--dry-run] [--rollback] [-h|--help]
#   (no flag)    build: prechecks -> ask every human input ONCE -> steps 1..12, stop at the first FAIL
#   --dry-run    print every step and every command, change nothing, need no root and no answers.
#                Prechecks print `would FAIL <reason>` and do NOT make dry-run exit non-zero (exit 0). Only a hard
#                refusal (wrong LIMS_ENV, wrong inventory, bad usage) exits 2, also in dry-run.
#   --rollback   undo in reverse order what bootstrap did (see the UNDO plan: `--rollback --dry-run`). Safe undo is
#                automatic; anything that destroys data or keys is printed as MANUAL commands, never run.
# Output: `PRECHECK <id> PASS|FAIL <reason>`, then `STEP <n> <name>` followed by `OK [note]` or `FAIL <reason>`.
# Exit: 0 ok | 1 a precheck or step FAILed (nothing after it ran) | 2 refused / usage, nothing run |
#       3 a MANUAL step is pending in non-interactive mode (do it, re-run: done steps are skipped).
# Idempotent: every step checks its real state first; done markers live in /etc/lims/bootstrap/done/. Re-run = resume.
# Never printed: secret values, the age private key, LUKS passphrases. Nothing is written inside the repo.
#
# Human inputs, asked ONCE at the start (interactive), or taken from these variables (non-interactive:
# LIMS_BOOTSTRAP_NONINTERACTIVE=1 + all variables below; a missing one is a FAIL, never a guess). Answers (not the
# passphrases) are kept in /etc/lims/bootstrap/answers.env (0600) so a re-run does not ask again; variables win over it.
#   LIMS_ENV                  must be `staging` (the only accepted value)
#   LIMS_INVENTORY_DIR        default infra/ansible/inventories/staging-lean (must resolve to that, dr/backup empty)
#   LIMS_ORIGIN_STAFF_WEB  LIMS_ORIGIN_PORTAL  LIMS_ORIGIN_API   public host names = inventory var `origins.*`
#                             (role edge_nginx/acme; same names infra/tests/external/* and infra/ci/smoke.sh read)
#   LIMS_ACME_EMAIL           TLS contact = role acme var `acme_email` (not needed for LIMS_ACME_MODE=internal_ca)
#   LIMS_ACME_MODE            role acme var `acme_mode`: letsencrypt | staging | internal_ca (default staging)   [CONV]
#   SOPS_AGE_KEY_FILE         where the age PRIVATE key is kept (default /root/.config/sops/age/keys.txt, 02-TRD 8.2)
#   LIMS_SECRETS_DIR          local checkout of the `lims-secrets` repo (default /root/lims-secrets-work)       [CONV]
#   LIMS_RELEASE              release id for infra/ci/deploy.sh, ^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$
#   LIMS_DISK_DB  LIMS_DISK_REPO1  LIMS_DISK_STORAGE  LIMS_DISK_DATA   the four private disks, /dev/disk/by-id/<name> (or just
#                             <name>), one per `disks:` key of the inventory. Asked from a listing of whole disks when
#                             unset. Written to /etc/lims/bootstrap/extra.yml as the var `disks` (extra vars beat the
#                             inventory value), so the repo's hosts.yml is never edited. Each must exist, be a whole
#                             disk, not mounted (except under /srv/lims/), and be used once.
#   LIMS_LUKS_PASSPHRASES_FILE  optional: a 0600 file holding `luks_volumes_passphrases: {<disk key>: <pass>}` (role
#                             luks_volumes) for blank disks; else asked silently, one per blank disk
# Other (optional): LIMS_RUNTIME_IMAGES_FILE (default /etc/lims/bootstrap/runtime-images.yml, MANUAL step 8),
#   LIMS_WHEELHOUSE (offline pip dir for ansible-core), LIMS_TLS_INSECURE / LIMS_TLS_CA (smoke.sh trust for the ACME
#   staging CA; set to 1 automatically for acme_mode staging|internal_ca).
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT=$PWD

DRY=0
MODE=build
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1; shift ;;
    --rollback) MODE=rollback; shift ;;
    -h | --help) awk 'NR > 1 && /^set -/ { exit } NR > 1 { print }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "usage: bootstrap.sh [--dry-run] [--rollback]  (unknown argument '$1')" >&2; exit 2 ;;
  esac
done

STATE=/etc/lims/bootstrap
DONE=$STATE/done
RUNDIR=/run/lims-bootstrap
LOG=/var/log/lims-bootstrap.log
VENV=/opt/lims/ansible-venv
NONINT=${LIMS_BOOTSTRAP_NONINTERACTIVE:-0}
NSTEPS=12

# ---- output helpers (same vocabulary as infra/cutover/server-smoke.sh) ----
note() { echo "  - $*"; }
plan() { echo "  + $*"; }
step() { echo "STEP $1 $2"; }
ok() { if [ "$DRY" -eq 1 ]; then echo "OK (dry-run: nothing executed)"; else echo "OK${*:+ $*}"; fi; }
fail() { echo "FAIL $*"; exit 1; }
# shellcheck disable=SC2329 # invoked via trap
on_err() { echo "FAIL unexpected error (line $1); nothing after this ran" >&2; }
trap 'on_err $LINENO' ERR
# shellcheck disable=SC2329 # invoked via trap
cleanup() { [ "$DRY" -eq 1 ] || rm -rf "$RUNDIR"; }
trap cleanup EXIT
# must CMD...: print then run; a failing command is a step FAIL. In dry-run only prints.
must() {
  plan "$*"
  [ "$DRY" -eq 1 ] && return 0
  local rc=0
  "$@" || rc=$?
  [ "$rc" -eq 0 ] || fail "'$1' failed (rc=$rc)"
}
mark() { [ "$DRY" -eq 1 ] || { install -d -m 0700 "$DONE"; : >"$DONE/$1"; }; }
marked() { [ -e "$DONE/$1" ]; }
# manual NAME CHECK-FN INSTRUCTIONS: print instructions, wait for the human, re-check. Non-interactive: exit 3.
manual() {
  local name=$1 chk=$2 msg=$3
  echo "MANUAL $name: the kit has no command for this. Do exactly:"
  printf '%s\n' "$msg" | sed 's/^/    /'
  if [ "$NONINT" = 1 ]; then
    echo "FAIL MANUAL step '$name' pending (non-interactive); do it, then re-run bootstrap.sh"; exit 3
  fi
  read -r -p "  Press Enter when done (Ctrl-C aborts; a re-run resumes here): " _ || fail "no terminal for the MANUAL step '$name'"
  "$chk" || fail "MANUAL step '$name' is not satisfied yet"
}

# ---- parameters ----
INV_REL=${LIMS_INVENTORY_DIR:-infra/ansible/inventories/staging-lean}
INV=$(realpath -m "$INV_REL")
INV_NAME=$(basename "$INV")
HOSTS_YML=$INV/hosts.yml
KEY_DEFAULT=/root/.config/sops/age/keys.txt
THIRD=infra/THIRD-PARTY-OPS.md

# table row `| <tool> | <version> | ...` of THIRD-PARTY-OPS.md (single source for pinned versions)
pinned() { awk -F'|' -v t="$1" '{ n = $2; gsub(/^ +| +$/, "", n) } n == t { v = $3; gsub(/^ +| +$/, "", v); print v; exit }' "$THIRD" 2>/dev/null; }
ANSIBLE_VER=$(pinned "Ansible (ansible-core)")
SOPS_VER=$(pinned "SOPS")
AGE_VER=$(pinned "age")

# ---- hard refusals (exit 2), also in --dry-run: this script builds ONLY the single staging host ----
if [ -n "${LIMS_ENV:-}" ] && [ "$LIMS_ENV" != staging ]; then
  echo "bootstrap.sh: refused: LIMS_ENV must be 'staging' (got '$LIMS_ENV'); this builds the one staging host only (CR NEPAL-single-host)" >&2; exit 2
fi
if [ -z "${LIMS_ENV:-}" ] && [ "$DRY" -eq 0 ]; then
  echo "bootstrap.sh: refused: set LIMS_ENV=staging" >&2; exit 2
fi
if [ "$INV_NAME" != staging-lean ] || [ "$(basename "$(dirname "$INV")")" != inventories ] || [ ! -f "$HOSTS_YML" ]; then
  echo "bootstrap.sh: refused: inventory must be .../inventories/staging-lean with a hosts.yml (got '$INV_REL')" >&2; exit 2
fi
if ! grep -Eq '^[[:space:]]+dr: \{\}' "$HOSTS_YML" || ! grep -Eq '^[[:space:]]+backup: \{\}' "$HOSTS_YML"; then
  echo "bootstrap.sh: refused: groups dr and backup must be empty ({}) in $HOSTS_YML (single host)" >&2; exit 2
fi
if ! grep -Eq '^env:[[:space:]]*staging[[:space:]]*(#.*)?$' "$INV/group_vars/all.yml" 2>/dev/null \
  || ! grep -Eq '^topology_profile:[[:space:]]*lean([[:space:]]|$)' "$INV/group_vars/all.yml" 2>/dev/null; then
  echo "bootstrap.sh: refused: $INV/group_vars/all.yml must say env: staging and topology_profile: lean" >&2; exit 2
fi
[ -n "$ANSIBLE_VER" ] && [ -n "$SOPS_VER" ] || { echo "bootstrap.sh: refused: cannot read the pinned versions from $THIRD" >&2; exit 2; }
if [ "$MODE" = build ] && [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "bootstrap.sh: refused: run as root on the server (or use --dry-run)" >&2; exit 2
fi
if [ "$MODE" = rollback ] && [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "bootstrap.sh: refused: --rollback runs as root (or use --rollback --dry-run)" >&2; exit 2
fi

# setup_run: first change on the host (log file, state dir, tmpfs run dir); called after the prechecks passed
setup_run() {
  [ "$DRY" -eq 1 ] && return 0
  install -d -m 0700 "$STATE" "$RUNDIR"
  exec > >(tee -a "$LOG") 2>&1
  echo "bootstrap: log $LOG"
}
echo "bootstrap: env=staging inventory=$INV root=$ROOT mode=$MODE$([ "$DRY" -eq 1 ] && echo ' (dry-run)')"
echo "bootstrap: pinned (THIRD-PARTY-OPS.md): ansible-core $ANSIBLE_VER, SOPS $SOPS_VER, age ${AGE_VER:-?}"

# ---- tools on the PATH for every ansible call below: our shim first, the venv next ----
export ANSIBLE_CONFIG=$ROOT/infra/ansible/ansible.cfg
export ANSIBLE_ROLES_PATH=$ROOT/infra/ansible/roles
export PATH=$STATE/bin:$VENV/bin:$PATH

# print "<key> <dev>" for every entry under `disks:` of hosts.yml (the only data source for the disk list)
disk_list() {
  awk '
    /^[[:space:]]*$/ || /^[[:space:]]*#/ { next }
    in_d { match($0, /^[[:space:]]*/); if (RLENGTH <= dind) { in_d = 0 } else {
      l = $0; sub(/^[[:space:]]+/, "", l); k = l; sub(/:.*/, "", k); v = l; sub(/^[^:]*:[[:space:]]*/, "", v)
      sub(/[[:space:]]*(#.*)?$/, "", v); print k, v; next } }
    /^[[:space:]]*disks:[[:space:]]*(#.*)?$/ { match($0, /^[[:space:]]*/); dind = RLENGTH; in_d = 1 }
  ' "$HOSTS_YML"
}

disk_var() { printf 'LIMS_DISK_%s' "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"; }
disk_norm() { case $1 in /*) echo "$1" ;; *) echo "/dev/disk/by-id/$1" ;; esac; }
# disk_check DEV: prints the reason and returns 1 when DEV is not a usable private disk
disk_check() {
  local dev=$1 real t m
  case $dev in *REPLACE*) echo "placeholder"; return 1 ;; esac
  case $dev in /dev/disk/by-id/*) ;; *) echo "not under /dev/disk/by-id (never /dev/sdX)"; return 1 ;; esac
  case $dev in *-part[0-9]*) echo "is a partition"; return 1 ;; esac
  real=$(realpath -e "$dev" 2>/dev/null) || { echo "does not exist"; return 1; }
  t=$(lsblk -dno TYPE "$real" 2>/dev/null || true)
  [ "$t" = disk ] || { echo "not a whole disk (type '${t:-unknown}')"; return 1; }
  m=$(lsblk -nro MOUNTPOINTS "$real" 2>/dev/null | grep -Ev '^$|^/srv/lims/' | tr '\n' ' ' || true)
  [ -z "$m" ] || { echo "in use (mounted at $m)"; return 1; }
}
# resolve_disks: DISKMAP[key]=device from LIMS_DISK_<KEY> (wins) or a non-placeholder hosts.yml value; DISK_ASK = keys still open
declare -A DISKMAP=()
DISK_ASK=""
resolve_disks() {
  local k dev v
  DISKMAP=(); DISK_ASK=""
  while read -r k dev; do
    [ -n "$k" ] || continue
    v=$(disk_var "$k")
    [ -z "${!v:-}" ] || dev=$(disk_norm "${!v}")
    case $dev in "" | *REPLACE*) DISK_ASK="$DISK_ASK $k"; continue ;; esac
    DISKMAP[$k]=$dev
  done < <(disk_list)
}
# disks_problems: prints one line per problem (bad disk, duplicate) for the resolved map
disks_problems() {
  local k r real seen=" "
  for k in "${!DISKMAP[@]}"; do
    r=$(disk_check "${DISKMAP[$k]}") || { echo "$k(${DISKMAP[$k]}: $r)"; continue; }
    real=$(realpath -e "${DISKMAP[$k]}")
    case $seen in *" $real "*) echo "$k(same disk used twice)" ;; esac
    seen="$seen$real "
  done
}

# ---- paths of the kit and of this script's state ----
LOCK=$ROOT/infra/releases/staging.lock.yaml
DEPLOYED=$ROOT/infra/releases/staging.deployed.lock.yaml
IMAGES_FILE=${LIMS_RUNTIME_IMAGES_FILE:-$STATE/runtime-images.yml}
EXTRA=$STATE/extra.yml
SHIM=$STATE/bin/ansible-playbook
LUKS_VARS=$RUNDIR/luks-vars.json
RUNTIME_KEYS="api worker web portal renderer pdf_sandbox valkey squid"

# =========================================================== rollback
run_rollback() {
  echo "bootstrap: UNDO plan, reverse order of the build steps. Data and keys are never deleted automatically."
  if [ "$DRY" -eq 0 ] && [ "$NONINT" != 1 ]; then
    read -r -p "  Type 'yes' to undo what bootstrap did on this host: " a || fail "no terminal"
    [ "$a" = yes ] || { echo "bootstrap: aborted, nothing changed"; exit 1; }
  fi
  if [ "$DRY" -eq 0 ]; then load_answers; export SOPS_AGE_KEY_FILE=${SOPS_AGE_KEY_FILE:-$KEY_DEFAULT}; fi
  local n=12
  step $n undo-smoke; note "nothing to undo (server-smoke.sh cleans its own temp files; docker rm -f drill-pg if you built it)"; ok
  n=11; step $n undo-deploy
  if [ "$DRY" -eq 1 ]; then
    plan "if infra/releases/staging.lock.yaml differs from staging.deployed.lock.yaml: LIMS_INVENTORY=$INV_NAME bash infra/ci/rollback.sh staging   (kit rollback: redeploys the last known good digests)"
    note "else nothing newer than the last known good exists; MANUAL: stop the app with docker compose -p lims -f /srv/lims/compose/lims/compose.app.yml down (needs the deploy env; stack data volumes stay)"
    ok
  elif [ -f "$DEPLOYED" ] && [ -f "$LOCK" ] && ! cmp -s "$LOCK" "$DEPLOYED"; then
    LIMS_INVENTORY=$INV_NAME must bash infra/ci/rollback.sh staging
    ok "(redeployed the last known good digests)"
  else
    note "no deploy newer than the last known good: infra/ci/rollback.sh has nothing to do"
    note "MANUAL (stops the app, keeps volumes): docker compose -p lims -f /srv/lims/compose/lims/compose.app.yml down"
    ok "(manual stop printed)"
  fi
  n=10; step $n undo-db-bootstrap
  note "MANUAL, DESTROYS THE DATABASE (synthetic data only, staging only): docker rm -f supabase-db ; wipe the db volume content under /srv/lims/db ; rm /srv/lims/pg/bootstrap.done"
  note "see infra/cutover/CUTOVER.md section 7 row 4.1; not run here"; ok "(manual)"
  n=9; step $n undo-site-runtime; note "no one-shot undo (site.yml is idempotent); see step 7"; ok
  n=8; step $n undo-images
  note "MANUAL: infra/releases/staging.lock.yaml is the kit's file; to go back: bash infra/ci/release-lock.sh staging <previous refs>"
  if [ "$DRY" -eq 1 ]; then plan "rm -f $IMAGES_FILE"; else rm -f "$IMAGES_FILE"; fi
  ok
  n=7; step $n undo-site
  note "no kit undo for site.yml. MANUAL, in this order, only if you really want the stack gone:"
  note "  docker compose -p lims -f /srv/lims/compose/lims/compose.app.yml down ; systemctl disable --now wg-quick@wg0 ; umount /srv/lims/* ; cryptsetup close luks_<key> for db repo1 storage data"
  note "  disks stay LUKS-formatted; wiping them is destructive: cryptsetup erase <by-id device> (never on a disk with data you need)"
  if [ "$DRY" -eq 1 ]; then plan "rm -f $DONE/site $DONE/site-partial"; else rm -f "$DONE/site" "$DONE/site-partial"; fi
  ok "(markers cleared; host config left in place)"
  n=6; step $n undo-secrets
  note "KEPT on purpose: losing the age key or staging.enc.yaml loses every secret. MANUAL if you must: shred -u <SOPS_AGE_KEY_FILE>; rm -rf <LIMS_SECRETS_DIR> (see $STATE/answers.env for the paths)"
  ok "(kept)"
  n=5; step $n undo-age-key; note "KEPT (see step 6)"; ok "(kept)"
  n=4; step $n undo-local-override
  if [ "$DRY" -eq 1 ]; then plan "rm -rf $STATE/bin $STATE/extra.yml $STATE/answers.env $STATE/done $RUNDIR"
  else rm -rf "${STATE:?}/bin" "${STATE:?}/extra.yml" "${STATE:?}/answers.env" "${STATE:?}/done" "${RUNDIR:?}"; rmdir "$STATE" 2>/dev/null || true; fi
  ok
  n=3; step $n undo-sops; note "MANUAL: rm /usr/local/bin/sops (installed by hand in step 3)"; ok "(manual)"
  n=2; step $n undo-ansible-core
  if [ "$DRY" -eq 1 ]; then plan "rm -rf $VENV"; else rm -rf "$VENV"; fi
  ok
  n=1; step $n undo-packages; note "KEPT (git age python3-venv python3-yaml curl ca-certificates are generic); MANUAL: apt-get remove <pkg>"; ok "(kept)"
  if [ "$DRY" -eq 1 ]; then echo "bootstrap: undo plan printed, nothing changed"; else echo "bootstrap: undo finished"; fi
}

# =========================================================== prechecks (before any change)
PC_FAILS=0
pc() { # id rc reason
  if [ "$2" -eq 0 ]; then echo "PRECHECK $1 PASS"; return 0; fi
  PC_FAILS=$((PC_FAILS + 1))
  if [ "$DRY" -eq 1 ]; then echo "PRECHECK $1 would FAIL $3"; else echo "PRECHECK $1 FAIL $3"; fi
}
pc_ask() { # id reason: not a failure, the value is asked in the input phase
  if [ "$DRY" -eq 1 ]; then echo "PRECHECK $1 would ASK $2"; else echo "PRECHECK $1 ASK $2"; fi
}
prechecks() {
  local rc=0 id ver cores ram_kb bad="" n=0
  pc env 0 ""
  pc inventory 0 ""
  if [ -r /etc/os-release ]; then
    # shellcheck source=/dev/null
    id=$(. /etc/os-release && echo "${ID:-}")
    # shellcheck source=/dev/null
    ver=$(. /etc/os-release && echo "${VERSION:-}")
    [ "$id" = ubuntu ] && [[ $ver == *LTS* ]] || rc=1
  else rc=1; fi
  pc ubuntu-lts "$rc" "needs Ubuntu LTS (/etc/os-release)"
  rc=0; [ "$(id -u)" -eq 0 ] || rc=1
  pc root "$rc" "run as root"
  rc=0; cores=$(nproc --all 2>/dev/null || echo 0); [ "$cores" -ge 16 ] || rc=1
  pc cores "$rc" "$cores cores < 16"
  rc=0; ram_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0); [ "${ram_kb:-0}" -ge 31457280 ] || rc=1
  pc ram "$rc" "$((${ram_kb:-0} / 1048576)) GiB < 30 GiB"
  resolve_disks
  n=$(disk_list | wc -l)
  bad=$(disks_problems | tr '\n' ' ')
  if [ "$n" -eq 0 ]; then pc disks 1 "no disks: entries in hosts.yml"
  elif [ -n "$bad" ]; then pc disks 1 "$bad"
  elif [ -n "$DISK_ASK" ]; then pc_ask disks "no disk chosen yet for:$DISK_ASK (set LIMS_DISK_<KEY>, or asked from a /dev/disk/by-id listing; hosts.yml is not edited)"
  else pc disks 0 ""; fi
  pc lims-env 0 ""
  pc staging-lean-dr-backup-empty 0 ""
  if [ "$PC_FAILS" -gt 0 ]; then
    if [ "$DRY" -eq 1 ]; then echo "bootstrap: $PC_FAILS precheck(s) would FAIL on this host; a real run would refuse. dry-run continues and exits 0"
    else echo "FAIL $PC_FAILS precheck(s) failed; refusing to change anything"; exit 1; fi
  fi
}

# =========================================================== inputs, asked ONCE
ANSWER_NAMES="LIMS_ORIGIN_STAFF_WEB LIMS_ORIGIN_PORTAL LIMS_ORIGIN_API LIMS_ACME_EMAIL LIMS_ACME_MODE SOPS_AGE_KEY_FILE LIMS_SECRETS_DIR LIMS_RELEASE"
for _k in $(disk_list | awk '{ print $1 }'); do ANSWER_NAMES="$ANSWER_NAMES $(disk_var "$_k")"; done
load_answers() {
  local k v n
  [ -f "$STATE/answers.env" ] || return 0
  while IFS='=' read -r k v; do
    for n in $ANSWER_NAMES; do
      [ "$k" = "$n" ] && [ -z "${!k:-}" ] && printf -v "$k" '%s' "$v"
    done
  done <"$STATE/answers.env"
  echo "bootstrap: reusing earlier answers from $STATE/answers.env (variables you set win)"
}
# ask VAR PROMPT [DEFAULT]
ask() {
  local var=$1 prompt=$2 def=${3:-} v=""
  [ -z "${!var:-}" ] || return 0
  if [ "$NONINT" = 1 ]; then
    [ -n "$def" ] || fail "non-interactive: set $var"
    printf -v "$var" '%s' "$def"; return 0
  fi
  [ -t 0 ] || fail "stdin is not a terminal: set LIMS_BOOTSTRAP_NONINTERACTIVE=1 and $var"
  read -r -p "  $prompt${def:+ [$def]}: " v || fail "no input for $var"
  printf -v "$var" '%s' "${v:-$def}"
  [ -n "${!var}" ] || fail "$var is required"
}
LUKS_KEYS_BLANK=""
declare -A LUKS_PASS=()
collect_inputs() {
  local fqdn='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' k dev t p1 p2 v prob
  echo "INPUTS (asked once; secrets are never echoed or logged)"
  if [ "$DRY" -eq 1 ]; then
    for k in LIMS_ORIGIN_STAFF_WEB LIMS_ORIGIN_PORTAL LIMS_ORIGIN_API LIMS_ACME_EMAIL LIMS_RELEASE; do
      note "$k = ${!k:-<asked at run time or taken from the variable>}"
    done
    note "LIMS_ACME_MODE = ${LIMS_ACME_MODE:-staging}   (letsencrypt|staging|internal_ca)"
    note "SOPS_AGE_KEY_FILE = ${SOPS_AGE_KEY_FILE:-$KEY_DEFAULT}   (age private key stays on this server at this path)"
    note "LIMS_SECRETS_DIR = ${LIMS_SECRETS_DIR:-/root/lims-secrets-work}"
    for k in $(disk_list | awk '{ print $1 }'); do
      v=$(disk_var "$k"); note "$v = ${!v:-<asked at run time from a /dev/disk/by-id listing of whole disks>}"
    done
    note "LUKS passphrase for each blank disk (hidden prompt, or LIMS_LUKS_PASSPHRASES_FILE): keys = $(disk_list | awk '{ printf "%s ", $1 }')"
    return 0
  fi
  load_answers
  ask LIMS_ORIGIN_STAFF_WEB "staff web host name (A record -> this server)"
  ask LIMS_ORIGIN_PORTAL "portal host name"
  ask LIMS_ORIGIN_API "api host name"
  ask LIMS_ACME_MODE "ACME mode (letsencrypt|staging|internal_ca)" staging
  case $LIMS_ACME_MODE in letsencrypt | staging | internal_ca) ;; *) fail "LIMS_ACME_MODE must be letsencrypt, staging or internal_ca" ;; esac
  if [ "$LIMS_ACME_MODE" != internal_ca ]; then ask LIMS_ACME_EMAIL "TLS contact e-mail (acme_email)"; else LIMS_ACME_EMAIL=${LIMS_ACME_EMAIL:-}; fi
  ask SOPS_AGE_KEY_FILE "where the age PRIVATE key is kept (path on this server)" "$KEY_DEFAULT"
  ask LIMS_SECRETS_DIR "lims-secrets checkout directory (path on this server)" /root/lims-secrets-work
  ask LIMS_RELEASE "release id for the first deploy (vX.Y.Z-rc.N)"
  resolve_disks
  if [ -n "$DISK_ASK" ]; then
    echo "  whole disks under /dev/disk/by-id (partitions left out; pick the 4 EMPTY private disks, never the OS disk):"
    for dev in /dev/disk/by-id/*; do
      case $dev in *-part[0-9]*) continue ;; esac
      [ "$(lsblk -dno TYPE "$(realpath -e "$dev" 2>/dev/null || echo /nonexistent)" 2>/dev/null || true)" = disk ] || continue
      echo "    $(basename "$dev")  $(lsblk -dno SIZE,MODEL "$(realpath -e "$dev")" 2>/dev/null | tr -s ' ')"
    done
    for k in $DISK_ASK; do
      v=$(disk_var "$k")
      ask "$v" "by-id disk for '$k' (name or full path)"
      printf -v "$v" '%s' "$(disk_norm "${!v}")"
    done
    resolve_disks
  fi
  prob=$(disks_problems | tr '\n' ' ')
  [ -z "$DISK_ASK" ] && [ -z "$prob" ] || fail "disks: ${prob:-unresolved:$DISK_ASK}"
  for k in "${!DISKMAP[@]}"; do echo "  disk $k -> ${DISKMAP[$k]}"; done
  for k in LIMS_ORIGIN_STAFF_WEB LIMS_ORIGIN_PORTAL LIMS_ORIGIN_API; do
    [[ ${!k} =~ $fqdn ]] || fail "$k '${!k}' is not a host name"
    case ${!k} in *.invalid | *.example | *.test | *.localhost) fail "$k '${!k}' is a placeholder name: use the real DNS name (server only)" ;; esac
  done
  [ "$LIMS_ORIGIN_STAFF_WEB" != "$LIMS_ORIGIN_PORTAL" ] && [ "$LIMS_ORIGIN_STAFF_WEB" != "$LIMS_ORIGIN_API" ] \
    && [ "$LIMS_ORIGIN_PORTAL" != "$LIMS_ORIGIN_API" ] || fail "the three host names must differ"
  if [ "$LIMS_ACME_MODE" != internal_ca ]; then
    [[ $LIMS_ACME_EMAIL =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail "LIMS_ACME_EMAIL is not an e-mail address"
    case $LIMS_ACME_EMAIL in *.invalid) fail "LIMS_ACME_EMAIL is a placeholder" ;; esac
  fi
  for k in SOPS_AGE_KEY_FILE LIMS_SECRETS_DIR; do
    [[ ${!k} =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "$k must be an absolute path (letters, digits . _ / -)"
    case $(realpath -m "${!k}")/ in "$ROOT"/*) fail "$k must be outside the repo checkout ($ROOT): no secret material in the repo" ;; esac
  done
  [[ $LIMS_RELEASE =~ ^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$ ]] || fail "LIMS_RELEASE must match ^v[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+\$ (infra/ci/deploy.sh, staging)"
  # LUKS passphrases only for disks that carry no LUKS header yet (role luks_volumes formats blank disks only)
  if [ -n "${LIMS_LUKS_PASSPHRASES_FILE:-}" ]; then
    [ -f "$LIMS_LUKS_PASSPHRASES_FILE" ] || fail "LIMS_LUKS_PASSPHRASES_FILE not found"
    [ "$(stat -c '%u:%a' "$LIMS_LUKS_PASSPHRASES_FILE")" = "0:600" ] || [ "$(stat -c '%u:%a' "$LIMS_LUKS_PASSPHRASES_FILE")" = "0:400" ] \
      || fail "LIMS_LUKS_PASSPHRASES_FILE must be owned by root, mode 0600 or 0400"
  else
    while read -r k _; do
      [ -n "$k" ] || continue
      dev=${DISKMAP[$k]}
      t=$(blkid -p -o value -s TYPE "$dev" 2>/dev/null || true)
      [ "$t" = crypto_LUKS ] && continue
      [ "$NONINT" != 1 ] || fail "non-interactive: disk '$k' is blank; set LIMS_LUKS_PASSPHRASES_FILE"
      [ -t 0 ] || fail "stdin is not a terminal: set LIMS_LUKS_PASSPHRASES_FILE"
      read -r -s -p "  LUKS passphrase for blank disk '$k' (held by founder/ops lead, hidden): " p1 || fail "no input"; echo
      read -r -s -p "  again: " p2 || fail "no input"; echo
      [ -n "$p1" ] && [ "$p1" = "$p2" ] || fail "passphrase for '$k' empty or different"
      LUKS_PASS[$k]=$p1; LUKS_KEYS_BLANK="$LUKS_KEYS_BLANK $k"
    done < <(disk_list)
  fi
  umask 077
  { for k in $ANSWER_NAMES; do printf '%s=%s\n' "$k" "${!k:-}"; done; } >"$STATE/answers.env"
  echo "  answers recorded in $STATE/answers.env (no secrets)"
}

print_plan() {
  cat <<EOF
PLAN (what this run will do on THIS host):
  1 packages            apt: git age python3-venv python3-yaml curl ca-certificates
  2 ansible-core        venv $VENV, pip ansible-core==$ANSIBLE_VER
  3 sops                MANUAL if sops $SOPS_VER is not installed (not an Ubuntu package)
  4 local-override      $EXTRA + $SHIM (ansible-playbook -c local), repo inventory untouched
  5 age-key             age-keygen (private key stays in the path you chose)
  6 secrets             lims-secrets checkout, .sops.yaml from the kit, role secrets_render tasks_from generate
  7 site                ansible-playbook -i $INV_NAME site.yml (stops at lims_runtime if no image digests yet)
  8 images              MANUAL: build.sh, push.sh, release lock, runtime-images file
  9 site-runtime        site.yml again with the digests (skipped when 7 was complete)
  10 db-bootstrap       ansible-playbook -i $INV_NAME db-bootstrap.yml (first deploy only; marker guard)
  11 deploy             infra/ci/deploy.sh staging <release> (runs deploy.yml, smoke.sh, rolls back on failure)
  12 smoke              prints the server-smoke.sh command
EOF
}

# =========================================================== steps
s1_packages() {
  step 1 packages
  if [ "$DRY" -eq 0 ] && dpkg -s git age python3-venv python3-yaml curl ca-certificates >/dev/null 2>&1; then ok "(already installed)"; return 0; fi
  must apt-get update
  must apt-get install -y --no-install-recommends git age python3-venv python3-yaml curl ca-certificates
  ok
}

s2_ansible() {
  step 2 ansible-core
  if [ "$DRY" -eq 0 ] && [ -x "$VENV/bin/ansible" ] && "$VENV/bin/ansible" --version 2>/dev/null | head -n 1 | grep -q "core $ANSIBLE_VER\]"; then
    ok "(ansible-core $ANSIBLE_VER already in $VENV)"; return 0
  fi
  note "version from $THIRD; pip is a build-time source (PyPI), or an offline wheelhouse via LIMS_WHEELHOUSE"
  must install -d -m 0755 "$(dirname "$VENV")"
  must python3 -m venv "$VENV"
  if [ -n "${LIMS_WHEELHOUSE:-}" ]; then
    must "$VENV/bin/pip" install --no-index --find-links "$LIMS_WHEELHOUSE" "ansible-core==$ANSIBLE_VER"
  else
    must "$VENV/bin/pip" install "ansible-core==$ANSIBLE_VER"
  fi
  mark venv-created
  if [ "$DRY" -eq 0 ]; then
    "$VENV/bin/ansible" --version | head -n 1 | grep -q "core $ANSIBLE_VER\]" || fail "ansible-core $ANSIBLE_VER not importable after install"
  fi
  ok
}

sops_ok() { command -v sops >/dev/null 2>&1 && sops --version 2>/dev/null | grep -q "$SOPS_VER"; }
s3_sops() {
  step 3 sops
  if [ "$DRY" -eq 1 ]; then plan "sops --version must print $SOPS_VER; else MANUAL (instructions printed at run time)"; ok; return 0; fi
  if sops_ok; then ok "(sops $SOPS_VER present)"; return 0; fi
  manual sops sops_ok "SOPS $SOPS_VER is not an Ubuntu package (infra/THIRD-PARTY-OPS.md). Install the pinned upstream release:
  1. download sops-v$SOPS_VER.linux.amd64 and the release's checksums file from the upstream project's v$SOPS_VER release page (build-time source);
  2. verify the sha256 against the checksums file; do not run an unverified binary;
  3. install -m 0755 <file> /usr/local/bin/sops
  4. check: sops --version prints $SOPS_VER"
  ok
}

s4_override() {
  step 4 local-override
  local want="" k
  if [ "$DRY" -eq 1 ]; then
    plan "write $EXTRA (0600): secrets_render_enc_file, acme_email, acme_mode, origins {staff_web,portal,api}, disks {db,repo1,storage,data} (non-secret)"
    plan "write $SHIM: exec ansible-playbook -c local -e @$EXTRA [-e @$IMAGES_FILE] [-e @$LUKS_VARS] \"\$@\""
    note "ansible_connection=local via the shim, so infra/ansible/inventories/staging-lean is NOT edited and infra/ci/deploy.sh still works unchanged"
    ok; return 0
  fi
  install -d -m 0700 "$STATE" "$STATE/bin"
  want=$(mktemp "$STATE/.extra.XXXXXX")
  {
    echo "---"
    echo "# generated by infra/cutover/bootstrap.sh; non-secret; outside the repo"
    echo "secrets_render_enc_file: \"$LIMS_SECRETS_DIR/staging.enc.yaml\""
    echo "acme_mode: \"$LIMS_ACME_MODE\""
    echo "acme_email: \"${LIMS_ACME_EMAIL:-}\""
    echo "origins: {staff_web: \"$LIMS_ORIGIN_STAFF_WEB\", portal: \"$LIMS_ORIGIN_PORTAL\", api: \"$LIMS_ORIGIN_API\"}"
    echo "# beats the inventory's placeholder disks (extra vars win); keys = the inventory's disks: keys"
    echo "disks:"
    for k in $(disk_list | awk '{ print $1 }'); do echo "  $k: \"${DISKMAP[$k]}\""; done
  } >"$want"
  chmod 0600 "$want"
  mv -f "$want" "$EXTRA"
  want=$(mktemp "$STATE/bin/.shim.XXXXXX")
  cat >"$want" <<EOF
#!/bin/sh
# generated by infra/cutover/bootstrap.sh: local connection + the non-secret extra vars for every ansible-playbook call
set -eu
args="-c local -e @$EXTRA"
[ ! -f "$IMAGES_FILE" ] || args="\$args -e @$IMAGES_FILE"
[ ! -f "$LUKS_VARS" ] || args="\$args -e @$LUKS_VARS"
# shellcheck disable=SC2086
set -- \$args "\$@"
exec "$VENV/bin/ansible-playbook" "\$@"
EOF
  chmod 0755 "$want"
  mv -f "$want" "$SHIM"
  mark local-override
  ok
}

age_ok() { [ -f "$SOPS_AGE_KEY_FILE" ] && age-keygen -y "$SOPS_AGE_KEY_FILE" >/dev/null 2>&1; }
s5_agekey() {
  step 5 age-key
  if [ "$DRY" -eq 1 ]; then
    plan "umask 077; mkdir -p \$(dirname \$SOPS_AGE_KEY_FILE); age-keygen -o \$SOPS_AGE_KEY_FILE   (only if absent; chmod 0400; key is never printed)"
    note "MANUAL after creation: name who keeps an offline copy of the key (printed at run time)"
    ok; return 0
  fi
  if age_ok; then ok "(age key present at $SOPS_AGE_KEY_FILE)"; return 0; fi
  [ ! -e "$SOPS_AGE_KEY_FILE" ] || fail "$SOPS_AGE_KEY_FILE exists but is not a valid age key; refusing to overwrite it"
  ( umask 077; mkdir -p "$(dirname "$SOPS_AGE_KEY_FILE")"; plan "age-keygen -o $SOPS_AGE_KEY_FILE"; age-keygen -o "$SOPS_AGE_KEY_FILE" >/dev/null 2>&1 ) \
    || fail "age-keygen failed"
  chmod 0400 "$SOPS_AGE_KEY_FILE"
  mark age-key-created
  echo "MANUAL custody: the private key is ONLY at $SOPS_AGE_KEY_FILE on this server. Lose it and every secret is lost."
  echo "    Write down who holds an offline copy (sealed envelope / password manager of founder + ops lead). Never paste it anywhere."
  if [ "$NONINT" != 1 ]; then read -r -p "  Press Enter once custody is arranged: " _ || fail "no terminal"; fi
  ok
}

secrets_ok() { SOPS_AGE_KEY_FILE=$SOPS_AGE_KEY_FILE sops -d --extract '["POSTGRES_PASSWORD"]' "$LIMS_SECRETS_DIR/staging.enc.yaml" >/dev/null 2>&1; }
s6_secrets() {
  step 6 secrets
  local recip gen enc
  if [ "$DRY" -eq 1 ]; then
    plan "install -d -m 0700 \$LIMS_SECRETS_DIR; git init (if new)"
    plan "\$LIMS_SECRETS_DIR/.sops.yaml = copy of infra/secrets/.sops.yaml with the staging recipient = age-keygen -y \$SOPS_AGE_KEY_FILE   (public key only; repo file untouched)"
    plan "SOPS_AGE_KEY_FILE=\$SOPS_AGE_KEY_FILE ansible-playbook -i $INV_NAME <generated wrapper> -e env=staging   (include_role secrets_render tasks_from=generate; refuses to overwrite)"
    plan "git add -A && git commit in \$LIMS_SECRETS_DIR;  verify: sops -d --extract '[\"POSTGRES_PASSWORD\"]' staging.enc.yaml >/dev/null"
    note "values are generated on the server and go only into staging.enc.yaml (encrypted); staging uses sandbox provider values only (REQ-SEC-136)"
    ok; return 0
  fi
  export SOPS_AGE_KEY_FILE
  enc=$LIMS_SECRETS_DIR/staging.enc.yaml
  if [ -f "$enc" ] && secrets_ok; then ok "(staging.enc.yaml present and decrypts; never regenerated, rotation is runbooks/secrets.md)"; return 0; fi
  [ ! -e "$enc" ] || fail "$enc exists but does not decrypt with $SOPS_AGE_KEY_FILE; refusing to overwrite (runbooks/secrets.md)"
  install -d -m 0700 "$LIMS_SECRETS_DIR"
  [ -d "$LIMS_SECRETS_DIR/.git" ] || must git -C "$LIMS_SECRETS_DIR" init -q
  recip=$(age-keygen -y "$SOPS_AGE_KEY_FILE") || fail "cannot derive the public key"
  sed -E "s/^(    age: )age1placeholderstaging[a-z0-9]*\$/\\1$recip/" infra/secrets/.sops.yaml >"$LIMS_SECRETS_DIR/.sops.yaml"
  [ "$(grep -c "$recip" "$LIMS_SECRETS_DIR/.sops.yaml")" -eq 1 ] || fail "could not set the staging recipient in .sops.yaml (kit file changed shape?)"
  gen=$RUNDIR/gen-secrets.yml
  cat >"$gen" <<'EOF'
---
# generated by infra/cutover/bootstrap.sh: runs the kit's role secrets_render, tasks_from generate (02-TRD 8.2)
- name: Generate the staging secret set on this host
  hosts: localhost
  connection: local
  gather_facts: false
  tasks:
    - name: secrets_render generate
      ansible.builtin.include_role:
        name: secrets_render
        tasks_from: generate
EOF
  must ansible-playbook -i "$INV" "$gen" -e env=staging \
    -e "secrets_render_schema_dir=$ROOT/infra/secrets/schema" \
    -e "secrets_render_upstream_dir=$ROOT/infra/compose/supabase/upstream" \
    -e "secrets_render_tests_dir=$ROOT/infra/tests/internal" \
    -e "secrets_render_ops_note=$ROOT/infra/ci/ops-note.sh"
  secrets_ok || fail "generated staging.enc.yaml does not decrypt"
  git -C "$LIMS_SECRETS_DIR" add -A
  git -C "$LIMS_SECRETS_DIR" -c user.name=lims-bootstrap -c user.email=lims-bootstrap@localhost.invalid commit -q -m "staging secrets generated by bootstrap.sh" \
    || fail "git commit in $LIMS_SECRETS_DIR failed"
  mark secrets-generated
  ok
}

images_ok() {
  local k
  [ -f "$LOCK" ] && [ -f "$IMAGES_FILE" ] || return 1
  for k in $RUNTIME_KEYS; do
    grep -Eq "^[[:space:]]+\"?$k\"?:[[:space:]]*\"?[^[:space:]\"]+@sha256:[0-9a-f]{64}\"?[[:space:]]*\$" "$IMAGES_FILE" || return 1
  done
  grep -q '^lims_runtime_images:' "$IMAGES_FILE"
}

# luks_vars: write the passphrases to tmpfs for the plays (removed on exit); never printed
luks_vars() {
  [ "$DRY" -eq 0 ] || return 0
  if [ -n "${LIMS_LUKS_PASSPHRASES_FILE:-}" ]; then ( umask 077; cp "$LIMS_LUKS_PASSPHRASES_FILE" "$LUKS_VARS.yml" ); mv -f "$LUKS_VARS.yml" "$LUKS_VARS"; return 0; fi
  [ -n "$LUKS_KEYS_BLANK" ] || return 0
  local k
  ( umask 077
    for k in $LUKS_KEYS_BLANK; do printf '%s\0%s\0' "$k" "${LUKS_PASS[$k]}"; done \
      | python3 -I -c 'import sys, json
p = sys.stdin.buffer.read().split(b"\0")[:-1]
json.dump({"luks_volumes_passphrases": {p[i].decode(): p[i + 1].decode() for i in range(0, len(p), 2)}}, sys.stdout)' >"$LUKS_VARS" )
}

# run_site: site.yml. rc 0 = complete (marker), 10 = stopped at the lims_runtime precondition (no digests yet), else FAIL.
run_site() {
  local lf rc=0 last
  lf=$(mktemp "$RUNDIR/site.XXXXXX.log")
  must ansible-playbook -i "$INV" --syntax-check infra/ansible/playbooks/site.yml
  luks_vars
  plan "ansible-playbook -i $INV infra/ansible/playbooks/site.yml   (no --limit/--tags: the inventory is one host; header of site.yml names none)"
  ansible-playbook -i "$INV" infra/ansible/playbooks/site.yml 2>&1 | tee "$lf" || rc=$?
  rm -f "$LUKS_VARS"
  [ "$rc" -eq 0 ] && { mark site; return 0; }
  last=$(grep -E '^TASK \[' "$lf" | tail -n 1 || true)
  if [[ $last == *"lims_runtime : Preconditions"* ]] && [ ! -f "$IMAGES_FILE" ]; then mark site-partial; return 10; fi
  fail "site.yml failed (rc=$rc) at: ${last:-unknown task}; fix and re-run bootstrap.sh (site.yml is idempotent)"
}

s7_site() {
  step 7 site
  local rc=0
  if [ "$DRY" -eq 1 ]; then
    plan "ansible-playbook -i $INV --syntax-check infra/ansible/playbooks/site.yml"
    plan "ansible-playbook -i $INV infra/ansible/playbooks/site.yml   (via the local shim; luks passphrases for blank disks from tmpfs; SOPS_AGE_KEY_FILE exported)"
    note "plays: baseline (base_os hardening wireguard nftables chrony luks_volumes docker_engine), pgbackrest, auditstore, monitoring, logging, registry, edge, clamav, runtime"
    note "without image digests the LIMS runtime play fails closed; that exact stop is treated as partial and step 9 completes it"
    ok; return 0
  fi
  if marked site; then ok "(site.yml already completed)"; return 0; fi
  export SOPS_AGE_KEY_FILE
  run_site || rc=$?
  if [ "$rc" -eq 10 ]; then ok "(partial: stopped at the lims_runtime precondition, no image digests yet; step 8 then step 9)"; else ok; fi
}

s8_images() {
  step 8 images
  if [ "$DRY" -eq 1 ]; then
    plan "require $LOCK and $IMAGES_FILE (lims_runtime_images with: $RUNTIME_KEYS)"
    note "MANUAL if missing: bash infra/ci/build.sh <release>; bash infra/ci/push.sh staging lims/<name>:<release> ...; push.sh mirror <image>@sha256:<hex> for valkey/squid/clamd; write the refs into the images file"
    ok; return 0
  fi
  if images_ok; then ok "(lock and runtime-images file present)"; return 0; fi
  manual images images_ok "The registry now exists (site.yml). Build and push the images, which writes infra/releases/staging.lock.yaml:
  1. bash infra/ci/build.sh $LIMS_RELEASE                      (images lims/api worker web portal renderer pdf-sandbox)
  2. docker login registry.lims.internal:5000                  (push.sh assumes a logged-in docker)
  3. bash infra/ci/push.sh staging lims/api:$LIMS_RELEASE lims/worker:$LIMS_RELEASE lims/web:$LIMS_RELEASE lims/portal:$LIMS_RELEASE lims/renderer:$LIMS_RELEASE lims/pdf-sandbox:$LIMS_RELEASE
  4. third-party images (valkey, squid, clamd), by digest: bash infra/ci/push.sh mirror <image>@sha256:<64 hex>
  5. create $IMAGES_FILE (0600) with the pushed refs:
       lims_runtime_images:
         api: registry.lims.internal:5000/lims/api@sha256:<64 hex>
         (same shape for: $RUNTIME_KEYS clamd)
  Note: STATUS.md says the web image may not build yet (typecheck red); if build.sh fails, stop and report."
  ok
}

s9_site_runtime() {
  step 9 site-runtime
  local rc=0
  if [ "$DRY" -eq 1 ]; then
    plan "ansible-playbook -i $INV infra/ansible/playbooks/site.yml   (again, with -e @$IMAGES_FILE; only if step 7 was partial)"
    ok; return 0
  fi
  if marked site; then ok "(site.yml was complete in step 7)"; return 0; fi
  export SOPS_AGE_KEY_FILE
  run_site || rc=$?
  [ "$rc" -eq 0 ] || fail "site.yml still stops at the lims_runtime precondition: check $IMAGES_FILE"
  ok
}

s10_dbbootstrap() {
  step 10 db-bootstrap
  if [ "$DRY" -eq 1 ]; then
    plan "ansible-playbook -i $INV infra/ansible/playbooks/db-bootstrap.yml   (first deploy only; refuses when /srv/lims/pg/bootstrap.done exists)"
    ok; return 0
  fi
  if [ -e /srv/lims/pg/bootstrap.done ]; then ok "(marker /srv/lims/pg/bootstrap.done present; the playbook would refuse a second run)"; return 0; fi
  export SOPS_AGE_KEY_FILE
  must ansible-playbook -i "$INV" infra/ansible/playbooks/db-bootstrap.yml
  [ -e /srv/lims/pg/bootstrap.done ] || fail "db-bootstrap.yml finished but /srv/lims/pg/bootstrap.done is missing"
  mark db-bootstrap
  ok
}

s11_deploy() {
  step 11 deploy
  if [ "$DRY" -eq 1 ]; then
    plan "LIMS_INVENTORY=$INV_NAME LIMS_ORIGIN_STAFF_WEB=.. LIMS_ORIGIN_PORTAL=.. LIMS_ORIGIN_API=.. [LIMS_TLS_INSECURE=1] bash infra/ci/deploy.sh staging \$LIMS_RELEASE"
    note "deploy.sh = deploy.yml with -i $INV_NAME and the lock digests (-e deploy_<name>_image), then smoke.sh; a failed smoke triggers infra/ci/rollback.sh"
    note "it calls ansible-playbook from PATH, so it picks up the local shim (-c local + extra vars); the kit scripts are not changed"
    ok; return 0
  fi
  if [ -f "$DEPLOYED" ] && cmp -s "$LOCK" "$DEPLOYED"; then ok "(staging.deployed.lock.yaml equals the lock: already deployed and green)"; return 0; fi
  export SOPS_AGE_KEY_FILE LIMS_INVENTORY=$INV_NAME LIMS_ORIGIN_STAFF_WEB LIMS_ORIGIN_PORTAL LIMS_ORIGIN_API
  case $LIMS_ACME_MODE in staging | internal_ca) export LIMS_TLS_INSECURE=${LIMS_TLS_INSECURE:-1} ;; esac
  must bash infra/ci/deploy.sh staging "$LIMS_RELEASE"
  mark deploy
  ok
}

s12_smoke() {
  step 12 smoke
  note "next, on this host as root:"
  note "  LIMS_ENV=staging bash infra/cutover/server-smoke.sh --dry-run"
  note "  /usr/local/lib/lims/bin/pgbackrest --stanza=lims backup --type=full --repo=1     (needed for PASS wal-archive; infra/cutover/CUTOVER.md 2.11)"
  note "  LIMS_ENV=staging bash infra/cutover/server-smoke.sh                              (exit code = number of FAILs; env table: infra/cutover/SERVER-TESTS.md)"
  ok
}

# =========================================================== main
if [ "$MODE" = rollback ]; then
  setup_run
  run_rollback
  exit 0
fi
prechecks
setup_run
collect_inputs
print_plan
if [ "$DRY" -eq 0 ] && [ "$NONINT" != 1 ]; then
  read -r -p "  Type 'yes' to build this host as described: " a || fail "no terminal"
  [ "$a" = yes ] || { echo "bootstrap: aborted, nothing changed"; exit 1; }
fi
s1_packages
s2_ansible
s3_sops
s4_override
s5_agekey
s6_secrets
s7_site
s8_images
s9_site_runtime
s10_dbbootstrap
s11_deploy
s12_smoke
if [ "$DRY" -eq 1 ]; then echo "bootstrap: dry-run complete, nothing executed"; else echo "bootstrap: complete ($NSTEPS steps)"; fi

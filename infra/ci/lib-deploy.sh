#!/usr/bin/env bash
# infra/ci/lib-deploy.sh - sourced by deploy.sh, rollback.sh, promote.sh (never run directly).
# Env/lock/inventory checks shared by every script that moves digests (02-TRD s12.1-12.3, AC-21.1).
# Caller sets HERE and PROG, and has `set -euo pipefail`.
REG="registry.lims.internal:5000"
ROOT=$(cd "$HERE/../.." && pwd)
REL_DIR=${RELEASES_DIR:-$ROOT/infra/releases}

die() { echo "$PROG: $*" >&2; exit 2; }      # bad usage: nothing was run
refuse() { echo "$PROG: $*" >&2; exit 1; }   # a precondition failed: nothing was run

check_env() { case "$1" in dev|staging|prod) ;; *) die "unknown env '$1' (dev|staging|prod)";; esac; }

# inventory_for <env>: prints the inventory dir; refuses one whose group_vars env is not <env> (AC-21.1).
# LD-45: prod defaults to the `lean` profile (prod-lean); override with LIMS_INVENTORY=<inventory name>.
inventory_for() {
  local env=$1 name=${LIMS_INVENTORY:-}
  if [ -z "$name" ]; then
    case "$env" in prod) name=prod-lean ;; *) name=$env ;; esac
  fi
  [[ $name =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "bad LIMS_INVENTORY: $name"
  local dir="$ROOT/infra/ansible/inventories/$name"
  grep -Eq "^env:[[:space:]]*$env[[:space:]]*(#.*)?\$" "$dir/group_vars/all.yml" 2>/dev/null ||
    refuse "inventory '$name' does not belong to env '$env'"
  echo "$dir"
}

# read_lock <file> <env>: validates the lock and fills IMG_ARGS with `-e deploy_<name>_image=<ref>` pairs.
# Every ref must be exactly $REG/<key>@sha256:<64 hex> (digest pin, Nepal registry only; 07-SEC A9).
read_lock() {
  local f=$1 env=$2 line key ref seen=0
  IMG_ARGS=()
  [ -f "$f" ] || refuse "no lock file: $f"
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line =~ ^env:\ (.+)$ ]]; then
      [ "${BASH_REMATCH[1]}" = "$env" ] || refuse "$f is for env '${BASH_REMATCH[1]}', not '$env'"
      seen=1
    elif [[ $line =~ ^\ \ \"(.+)\":\ \"(.+)\"$ ]]; then
      key=${BASH_REMATCH[1]}; ref=${BASH_REMATCH[2]}
      [[ $key =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ && $ref =~ @sha256:[0-9a-f]{64}$ &&
        ${ref%@sha256:*} = "$REG/$key" ]] ||
        refuse "lock entry '$key' is not a $REG digest reference: $ref"
      if [[ $key =~ ^lims/([a-z0-9]+(-[a-z0-9]+)*)$ ]]; then
        key=${BASH_REMATCH[1]}
        IMG_ARGS+=(-e "deploy_${key//-/_}_image=$ref")
      fi
    fi
  done < "$f"
  [ "$seen" = 1 ] || refuse "$f has no env: line"
  [ ${#IMG_ARGS[@]} -gt 0 ] || refuse "$f holds no lims/* image"
}

# env_lock <env>: 03-APP-FLOW s2.1 - one deploy/rollback per env at a time; a second one waits <= 10 min, then fails.
# Exported LIMS_ENV_LOCK_HELD lets rollback.sh, when called by deploy.sh, reuse the held lock (fd 9 is inherited).
env_lock() {
  [ "${LIMS_ENV_LOCK_HELD:-}" = 1 ] && return 0
  exec 9>"${LIMS_DEPLOY_LOCK_DIR:-/var/lock}/lims-deploy-$1"
  flock -w 600 9 || refuse "env lock for $1 held > 10 min: another deploy/rollback is running"
  export LIMS_ENV_LOCK_HELD=1
}

# prod_key_check <env> <hint>: 02-TRD s12.2 - the runner holds no prod key; lims-prod-decrypt@<release> releases it
# to LIMS_PROD_KEY_FILE (default /run/lims/ci-prod/age.key). Refuses before anything runs if it is not readable.
prod_key_check() {
  [ "$1" = prod ] || return 0
  [ -r "${LIMS_PROD_KEY_FILE:-/run/lims/ci-prod/age.key}" ] || refuse "prod key not released: $2"
}

# run_deploy <env> <release> <inventory-dir> [roll-marker]: IMG_ARGS must be filled. SOPS_AGE_KEY_FILE for prod ONLY.
run_deploy() {
  local extra=()
  [ -n "${4:-}" ] && extra=(-e "deploy_roll_marker=$4")
  if [ "$1" = prod ]; then
    SOPS_AGE_KEY_FILE=${LIMS_PROD_KEY_FILE:-/run/lims/ci-prod/age.key} \
      ansible-playbook -i "$3" "$ROOT/infra/ansible/playbooks/deploy.yml" -e "deploy_release=$2" "${IMG_ARGS[@]}" "${extra[@]}"
  else
    ansible-playbook -i "$3" "$ROOT/infra/ansible/playbooks/deploy.yml" -e "deploy_release=$2" "${IMG_ARGS[@]}" "${extra[@]}"
  fi
}

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

# run_deploy <env> <release> <inventory-dir>: IMG_ARGS must be filled.
run_deploy() {
  ansible-playbook -i "$3" "$ROOT/infra/ansible/playbooks/deploy.yml" -e "deploy_release=$2" "${IMG_ARGS[@]}"
}

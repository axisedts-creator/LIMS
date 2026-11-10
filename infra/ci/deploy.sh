#!/usr/bin/env bash
# infra/ci/deploy.sh <env> <release> - runs ansible-playbook deploy.yml (02-TRD s12.3, AC-20.1-20.3, AC-21.1).
#   release: prod vX.Y.Z, staging vX.Y.Z-rc.N, dev [A-Za-z0-9._-]+ (<=64).
#   Pre-flight (nothing runs if it fails): <RELEASES_DIR>/<env>.lock.yaml valid and for <env>; inventory belongs
#   to <env> (LIMS_INVENTORY, default per env; prod = prod-lean, LD-45); no restore-drill lock
#   (LIMS_DRILL_LOCK, default /var/lock/lims-drill); prod: LIMS_APPROVED_RELEASE == <release> (the approval
#   recorded in the CI environment; the prod key is decrypted by lims-prod-decrypt@<release>, not by this script).
#   Then deploy.yml, then smoke.sh; smoke fails -> rollback.sh + exit 1. Smoke ok -> the lock is copied to
#   <env>.deployed.lock.yaml (last known good, used by rollback.sh and promote.sh).
#   NOT done here: verify.yml and registry-has-digests pre-flight, drill-age / backup-page check (02-TRD s12.3 step 1;
#   no data source in the spec); deploy.yml pulls by digest and fails on a missing one.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PROG=deploy.sh
. "$HERE/lib-deploy.sh"

[ $# -eq 2 ] || die "usage: deploy.sh <dev|staging|prod> <release>"
env=$1; rel=$2
check_env "$env"
case "$env" in
  prod) re='^v[0-9]+\.[0-9]+\.[0-9]+$' ;;
  staging) re='^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$' ;;
  *) re='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' ;;
esac
[[ $rel =~ $re ]] || die "bad release id for $env: $rel"

[ ! -e "${LIMS_DRILL_LOCK:-/var/lock/lims-drill}" ] || refuse "restore drill lock held: no deploy during a drill"
if [ "$env" = prod ] && [ "${LIMS_APPROVED_RELEASE:-}" != "$rel" ]; then
  refuse "prod deploy of $rel needs LIMS_APPROVED_RELEASE=$rel (founder approval)"
fi
lock="$REL_DIR/$env.lock.yaml"
read_lock "$lock" "$env"
inv=$(inventory_for "$env")

run_deploy "$env" "$rel" "$inv" || refuse "ansible-playbook failed: smoke not run, no known-good update"
if ! "$HERE/smoke.sh" "$env"; then
  echo "$PROG: smoke failed for $rel: rolling back $env" >&2
  "$HERE/rollback.sh" "$env" || echo "$PROG: ROLLBACK FAILED for $env: manual recovery needed" >&2
  exit 1
fi

mkdir -p "$REL_DIR"
tmp=$(mktemp "$REL_DIR/.$env.deployed.XXXXXX")
cp "$lock" "$tmp"
mv -f "$tmp" "$REL_DIR/$env.deployed.lock.yaml"
echo "$PROG: $rel deployed to $env"

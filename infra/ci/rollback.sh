#!/usr/bin/env bash
# infra/ci/rollback.sh <env> - redeploy the previous (last known good) digests (02-TRD s12.3 step 7, AC-20.3).
#   Reads <RELEASES_DIR>/<env>.deployed.lock.yaml (written by deploy.sh after a green smoke), runs deploy.yml with
#   THOSE digests, then increments lims_ops_deploy_rolled_back_total{env} (alert DeployRolledBack) in
#   TEXTFILE_DIR/lims_ops_deploy_rolled_back.prom (default /var/lib/node_exporter/textfile; atomic rename).
#   No known-good lock or a failed redeploy -> non-zero and the counter is untouched. Migrations stay (additive-first).
#   The drill lock is not checked: a rollback must not wait for a drill.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PROG=rollback.sh
. "$HERE/lib-deploy.sh"

[ $# -eq 1 ] || die "usage: rollback.sh <dev|staging|prod>"
env=$1
check_env "$env"
env_lock "$env"

read_lock "$REL_DIR/$env.deployed.lock.yaml" "$env"
inv=$(inventory_for "$env")
# the key released for the approved release is still within its TTL when deploy.sh calls us
prod_key_check "$env" "start lims-prod-decrypt@<approved release> first"
run_deploy "$env" rollback "$inv" || refuse "redeploy of the previous digests failed for $env: manual recovery needed"

tf=${TEXTFILE_DIR:-/var/lib/node_exporter/textfile}
prom=$tf/lims_ops_deploy_rolled_back.prom
mkdir -p "$tf"
declare -A n=([dev]=0 [staging]=0 [prod]=0)
if [ -f "$prom" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line =~ ^lims_ops_deploy_rolled_back_total\{env=\"(dev|staging|prod)\"\}\ ([0-9]+)$ ]]; then
      n[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}
    fi
  done < "$prom"
fi
n[$env]=$((n[$env] + 1))
tmp=$(mktemp "$tf/.rolled_back.XXXXXX.prom")
{
  echo "# HELP lims_ops_deploy_rolled_back_total Deploys rolled back after a failed smoke test."
  echo "# TYPE lims_ops_deploy_rolled_back_total counter"
  for e in dev staging prod; do echo "lims_ops_deploy_rolled_back_total{env=\"$e\"} ${n[$e]}"; done
} > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$prom"
echo "$PROG: $env rolled back to the previous digests"

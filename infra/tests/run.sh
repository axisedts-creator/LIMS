#!/usr/bin/env bash
# infra/tests/run.sh — T-01 gate: gitleaks, yamllint, ansible-lint, static tests.
# LD-06 (2026-11-07): writer deliverable. Missing tool = FAIL, except ansible-lint off CI (LD-17).
# The Lint class is excluded below: it calls this script (self-recursion).
#
#   run.sh        the T-01 gate (above), unchanged.
#   run.sh all    T-30 (AC-01.1..01.4): the gate + the WHOLE static suite + every live external and internal check of
#                 infra/tests/external/* and infra/tests/internal/*, against a DEPLOYED env. Needs LIMS_ENV=staging|prod
#                 (else exit 2 before any step) and runs on ops-1 (the vantage of 02-TRD s18; lean: the one prod host).
#                 Fail closed: a check whose env is missing exits 2 inside its script = `not ok`. [CONV] env names:
#   LIMS_INVENTORY_DIR (default infra/ansible/inventories/$LIMS_ENV; set it for the lean profile, LD-45), LIMS_PUBLIC_IFACE,
#   LIMS_ORIGIN_* / LIMS_TLS_* / LIMS_TEST_SOURCE_IPS / LIMS_F2B_CMD (external scripts, see their headers),
#   LIMS_WG_IP, LIMS_PUBLIC_IP, LIMS_COMPOSE_CONFIGS (space list of `docker compose config` files), LIMS_SECRETS_VALUES
#   (decrypted values file on the runner's tmpfs), LIMS_EGRESS_{DB,EDGE,PROXY}_CONTAINERS, LIMS_CLAMD_CONTAINER,
#   LIMS_APP_DB_URL, LIMS_AUDIT_DB_URL (psql), plus the env of each internal script (renderer, sandbox, valkey, auth_net, registry).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
mode=${1:-gate}
if [ $# -gt 1 ]; then echo "usage: run.sh [all]" >&2; exit 2; fi
case $mode in
  gate) ;;
  all)
    case "${LIMS_ENV:-}" in
      staging | prod) ;;
      *) echo "run.sh all: set LIMS_ENV=staging or LIMS_ENV=prod" >&2; exit 2 ;;
    esac ;;
  *) echo "usage: run.sh [all]  (unknown mode '$mode')" >&2; exit 2 ;;
esac
export PYTHONDONTWRITEBYTECODE=1
rc=0
step() { name=$1; shift; if "$@"; then echo "ok - $name"; else echo "not ok - $name"; rc=1; fi; }

step gitleaks gitleaks detect --no-git --source infra --no-banner --redact --exit-code 1
# pip --user installs may leave the yamllint script off PATH; the module still counts. Absent = FAIL.
if command -v yamllint >/dev/null; then step yamllint yamllint infra; else step yamllint python -m yamllint infra; fi
# LD-17 (2026-11-07): ansible-lint does not run on native Windows; missing = FAIL only when CI=true.
if ! command -v ansible-lint >/dev/null; then
  if [ "${CI:-}" = "true" ]; then echo "not ok - ansible-lint missing"; rc=1; else echo "SKIP ansible-lint (CI only)"; fi
elif [ -d infra/ansible ]; then step ansible-lint ansible-lint infra/ansible
else echo "ok - ansible-lint (no infra/ansible yet)"; fi
if [ "$mode" = gate ]; then
  step static python -I -m unittest discover -s infra/tests/static -p "test_t01_*.py" -k Skeleton -k Gitleaks -k SopsConfig -k SecretsSchema -k ThirdParty
  exit $rc
fi

# ---- all: the whole static suite (test_t01's Lint class re-runs the plain gate above: slow, never recursive) ----
export LIMS_ENV
step static-all python -I -m unittest discover -s infra/tests/static -p "test_t*.py"
EXT=infra/tests/external INT=infra/tests/internal
INV=${LIMS_INVENTORY_DIR:-infra/ansible/inventories/$LIMS_ENV}
# each every-file-must-be-here guard: a new script under tests/external or tests/internal that nobody wired in = `not ok`
handled=" ports.py tls.sh headers.py routes.py ratelimit.py bans.py published_ports.py secrets_not_default.py docker_inspect_secrets.py \
container_hardening.py renderer_egress.sh sandbox_envelope.sh valkey_ephemeral.sh registry_egress.sh egress_probe.sh eicar_probe.sh \
auth_net.sh nft_ruleset.py roles.sql auditstore_roles.sql probe_lib.sh oncall_sudo.sh rotation_load.py "
unwired=""
for f in infra/tests/external/* infra/tests/internal/*; do
  case "$handled" in *" ${f##*/} "*) ;; *) unwired="$unwired ${f##*/}" ;; esac
done
if [ -z "$unwired" ]; then echo "ok - every external/internal script is wired into run.sh all"; else echo "not ok - not wired into run.sh all:$unwired"; rc=1; fi

# an empty URL would make psql use the local default database: refuse (fail closed)
psqlf() { [ -n "$2" ] || { echo "$1: database URL env is empty" >&2; return 2; }; psql -X -v ON_ERROR_STOP=1 -f "$1" "$2"; }

# ---- external (AC-01.1, AC-01.2, 02-TRD s6): from ops-1's public interface; targets come from the inventory (LD-45) ----
step ports python3 "$EXT/ports.py" --inventory "$INV"
step tls bash "$EXT/tls.sh"
step headers python3 "$EXT/headers.py"
step routes python3 "$EXT/routes.py"
step ratelimit python3 "$EXT/ratelimit.py"
step bans python3 "$EXT/bans.py"

# ---- internal (run on the host under test) ----
# oncall_sudo.sh is quarterly (07-SEC), not every deploy: run it by hand as root. rotation_load.py runs from rotate-secret.yml.
# probe_lib.sh is the library the probes source.
step nft_ruleset python3 "$INT/nft_ruleset.py" --public-iface "${LIMS_PUBLIC_IFACE:-}"
step published_ports python3 "$INT/published_ports.py" --wg-ip "${LIMS_WG_IP:-}" ${LIMS_PUBLIC_IP:+--public-ip "$LIMS_PUBLIC_IP"} ${LIMS_COMPOSE_CONFIGS:-}
step secrets_not_default python3 "$INT/secrets_not_default.py" --env "$LIMS_ENV" --values "${LIMS_SECRETS_VALUES:-/nonexistent}"
step docker_inspect_secrets bash -c 'set -o pipefail; docker inspect $(docker ps -q) | python3 "$0" --inspect - --secrets-dir /run/lims/secrets --schema "infra/secrets/schema/$LIMS_ENV.secrets.schema.yaml"' "$INT/docker_inspect_secrets.py"
step container_hardening python3 "$INT/container_hardening.py" --daemon-json /etc/docker/daemon.json
step renderer_egress bash "$INT/renderer_egress.sh"
step sandbox_envelope bash "$INT/sandbox_envelope.sh"
step valkey_ephemeral bash "$INT/valkey_ephemeral.sh"
step registry_egress bash "$INT/registry_egress.sh"
step auth_net bash "$INT/auth_net.sh"
step egress_probe-auth bash "$INT/egress_probe.sh" auth
for m in db edge proxy; do
  var=LIMS_EGRESS_$(printf '%s' "$m" | tr a-z A-Z)_CONTAINERS
  list=${!var:-}
  if [ -z "$list" ]; then echo "not ok - egress_probe-$m ($var is empty)"; rc=1; continue; fi
  for c in $list; do step "egress_probe-$m-$c" bash "$INT/egress_probe.sh" "$m" "$c"; done
done
step eicar_probe bash "$INT/eicar_probe.sh" "${LIMS_CLAMD_CONTAINER:-}"
step roles.sql psqlf "$INT/roles.sql" "${LIMS_APP_DB_URL:-}"
step auditstore_roles.sql psqlf "$INT/auditstore_roles.sql" "${LIMS_AUDIT_DB_URL:-}"
exit $rc

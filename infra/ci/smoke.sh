#!/usr/bin/env bash
# infra/ci/smoke.sh <env> - external tests (tests/external/*) against an env (02-TRD s12.3 step 6).
#   The tests read their targets from LIMS_ORIGIN_* / LIMS_EDGE_ADDR / LIMS_TLS_* (the pipeline sets them; a test
#   that is unconfigured exits non-zero, so an unconfigured smoke fails closed). All tests run; any failure -> exit 1.
#   SMOKE_INDUCE_FAILURE=1 -> exit 1 at once, no network (rollback drill); refused (exit 2) in prod so a
#   pipeline variable can not fake a prod outage.
#   NOT done: the per-chunk synthetic journeys (C0 nightly list, no file in the spec).
set -euo pipefail

die() { echo "smoke.sh: $*" >&2; exit 2; }
[ $# -eq 1 ] || die "usage: smoke.sh <dev|staging|prod>"
env=$1
case "$env" in dev|staging|prod) ;; *) die "unknown env '$env' (dev|staging|prod)";; esac

if [ "${SMOKE_INDUCE_FAILURE:-}" = 1 ]; then
  [ "$env" != prod ] || die "SMOKE_INDUCE_FAILURE is refused in prod"
  echo "smoke.sh: induced failure (SMOKE_INDUCE_FAILURE=1) in $env" >&2
  exit 1
fi

root=$(cd "$(dirname "$0")/../.." && pwd)
ran=0 fail=0
for t in "$root"/infra/tests/external/*; do
  case "$t" in
    *.py) cmd=(python3 "$t") ;;
    *.sh) cmd=(bash "$t") ;;
    *) continue ;;
  esac
  ran=1
  echo "smoke.sh: $(basename "$t")"
  "${cmd[@]}" || { echo "smoke.sh: FAILED $(basename "$t") in $env" >&2; fail=1; }
done
[ "$ran" = 1 ] || die "no tests under tests/external"
exit "$fail"

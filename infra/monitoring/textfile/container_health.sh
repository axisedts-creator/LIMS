#!/usr/bin/env bash
# container_health.sh - 02-TRD s11.1 lims_ops_container_health{service} (AC-10.1). Run every 30 s by root on the host.
# Read-only docker CLI use (ps, inspect). One gauge per compose service (label com.docker.compose.service):
# 1 only when every container of the service is running AND its Docker healthcheck says `healthy`; else 0.
# Output: $TEXTFILE_DIR/container_health.prom (atomic) or stdout when unset.
# Docker unreadable: exit 1, no sample, stale container_health.prom removed (never a stale healthy 1).
set -u -o pipefail
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys' >/dev/null 2>&1; then PY=$c; break; fi
done
fail() {
  echo "container_health.sh: $1" >&2
  [ -n "${TEXTFILE_DIR:-}" ] && rm -f "$TEXTFILE_DIR/container_health.prom"
  exit 1
}
[ -n "$PY" ] || fail "python missing"

ids=$(docker ps -a -q --no-trunc) || fail "docker unreadable"
json="[]"
if [ -n "$ids" ]; then
  # ids are hex from docker; a container removed mid-run makes inspect exit 1 but the rest is still printed
  # shellcheck disable=SC2086
  json=$(docker inspect $ids 2>/dev/null) || true
fi

# Labels are untrusted: only valid compose service names become a label value, anything else is skipped.
body=$(printf '%s' "$json" | "$PY" -c '
import json, re, sys
sys.stdout.reconfigure(newline="\n")
ok = {}
for d in json.load(sys.stdin):
    svc = (d.get("Config", {}).get("Labels") or {}).get("com.docker.compose.service", "")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", svc or ""):
        continue
    st = d.get("State") or {}
    healthy = bool(st.get("Running")) and (st.get("Health") or {}).get("Status") == "healthy"
    ok[svc] = ok.get(svc, True) and healthy
print("# HELP lims_ops_container_health 1 when every container of the compose service is running and healthy, else 0.")
print("# TYPE lims_ops_container_health gauge")
for svc in sorted(ok):
    print("lims_ops_container_health{service=\"%s\"} %d" % (svc, ok[svc]))
') || fail "cannot read docker state"
[ -n "$body" ] || fail "empty output"
body+=$'\n'

if [ -z "${TEXTFILE_DIR:-}" ]; then
  printf '%s' "$body"
  exit 0
fi
tmp=$(mktemp "$TEXTFILE_DIR/.container_health.prom.XXXXXX") || fail "cannot write $TEXTFILE_DIR"
trap 'rm -f "$tmp"' EXIT
printf '%s' "$body" > "$tmp" && chmod 0644 "$tmp" && mv "$tmp" "$TEXTFILE_DIR/container_health.prom" || fail "cannot write container_health.prom"

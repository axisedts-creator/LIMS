#!/usr/bin/env bash
# edge_metrics.sh - 02-TRD s11.3 EdgeNotFoundSpike (08 A25 D-211, AC-04.7). Run every minute.
# Asks VictoriaLogs for the edge 404s of the last 5 minutes, counts them per client address here, and exports
#   lims_ops_edge_not_found_max_per_ip_5m <highest per-IP count>
# The address is never a label or a value. Output: $TEXTFILE_DIR/edge.prom (atomic) or stdout when unset.
# When VictoriaLogs cannot be read: exit 1, no sample, and any stale edge.prom is removed (never a healthy 0).
set -u -o pipefail
VL_URL=${VL_URL:-http://127.0.0.1:9428}
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys' >/dev/null 2>&1; then PY=$c; break; fi
done
fail() {
  echo "edge_metrics.sh: $1" >&2
  [ -n "${TEXTFILE_DIR:-}" ] && rm -f "$TEXTFILE_DIR/edge.prom"
  exit 1
}
[ -n "$PY" ] || fail "python missing"

max=$(curl -sS --fail --max-time 30 -X POST "$VL_URL/select/logsql/query" \
  --data-urlencode 'query=_time:5m status:404 | fields remote_addr, status' \
  | "$PY" -c '
import collections, ipaddress, json, sys
n = collections.Counter()
for line in sys.stdin:
    try:
        d = json.loads(line)
        if str(d.get("status")) != "404":
            continue
        n[str(ipaddress.ip_address(str(d.get("remote_addr", ""))))] += 1
    except Exception:
        continue  # log content is untrusted: skip anything that is not a 404 line with a valid address
print(max(n.values(), default=0))
') || fail "VictoriaLogs query failed"
[[ "$max" =~ ^[0-9]+$ ]] || fail "unexpected count"

body=$'# HELP lims_ops_edge_not_found_max_per_ip_5m Highest per-client count of edge 404s in the last 5 minutes.\n'
body+=$'# TYPE lims_ops_edge_not_found_max_per_ip_5m gauge\n'
body+="lims_ops_edge_not_found_max_per_ip_5m $max"$'\n'
if [ -z "${TEXTFILE_DIR:-}" ]; then
  printf '%s' "$body"
  exit 0
fi
tmp=$(mktemp "$TEXTFILE_DIR/.edge.prom.XXXXXX") || fail "cannot write $TEXTFILE_DIR"
trap 'rm -f "$tmp"' EXIT
printf '%s' "$body" > "$tmp" && chmod 0644 "$tmp" && mv "$tmp" "$TEXTFILE_DIR/edge.prom" || fail "cannot write edge.prom"

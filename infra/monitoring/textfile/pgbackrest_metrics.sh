#!/usr/bin/env bash
# pgbackrest_metrics.sh - 02-TRD s9.4 / s15 textfile metrics (every minute, data-1).
# Exports lims_ops_wal_repo2_newest_age_seconds, lims_ops_wal_unarchived_bytes,
# lims_ops_wal_check_consecutive_failures, lims_ops_offsite_archive_configured,
# lims_ops_backup_last_success_timestamp_seconds{repo,type}, lims_ops_backup_duration_seconds{repo,type}.
# Uses `pgbackrest` and `psql` from PATH (on the host: role pgbackrest wrappers that exec into the
# db container). Output: $TEXTFILE_DIR/pgbackrest.prom (atomic) or stdout when TEXTFILE_DIR is unset.
# Exit 1 when a source failed; metrics that could not be read are omitted, never reported as healthy.
set -u -o pipefail
PY=$(command -v python3 || command -v python) || { echo "python3 missing" >&2; exit 2; }
state_dir=${STATE_DIR:-/var/lib/lims/pgbackrest}
now=$(date +%s)
rc=0
out=""
add() { out+="$1"$'\n'; }

# --- backups + repo2 archive max from `info --output=json`
repo2_line=""
if info=$(pgbackrest --stanza=lims --output=json info 2>/dev/null) && [ -n "$info" ]; then
  parsed=$(printf '%s' "$info" | "$PY" -c '
import json, re, sys
st = json.load(sys.stdin)
st = next((s for s in st if s.get("name") == "lims"), None) if isinstance(st, list) else None
if st is None:
    sys.exit(1)
a2 = [a for a in st.get("archive", []) if a.get("database", {}).get("repo-key") == 2]
a2 = a2[-1] if a2 else {}
aid, mx = str(a2.get("id", "")), str(a2.get("max") or "")
ok2 = any(r.get("key") == 2 and r.get("status", {}).get("code") == 0 for r in st.get("repo", []))
print("REPO2 %s %s %d" % (aid if re.fullmatch(r"\d+-\d+", aid) else "-",
                          mx if re.fullmatch(r"[0-9A-F]{24}", mx) else "-", ok2))
newest = {}
for b in st.get("backup", []):
    k = (b.get("database", {}).get("repo-key"), b.get("type"))
    ts = b.get("timestamp", {})
    if k[0] in (1, 2) and k[1] in ("full", "diff", "incr") and ts.get("stop") and ts.get("start"):
        if k not in newest or ts["stop"] > newest[k][1]:
            newest[k] = (int(ts["start"]), int(ts["stop"]))
for (r, t), (s, e) in sorted(newest.items()):
    print("lims_ops_backup_last_success_timestamp_seconds{repo=\"%d\",type=\"%s\"} %d" % (r, t, e))
    print("lims_ops_backup_duration_seconds{repo=\"%d\",type=\"%s\"} %d" % (r, t, e - s))
' | tr -d '\r') || rc=1
  repo2_line=$(printf '%s\n' "${parsed:-}" | grep '^REPO2 ' || true)
  while IFS= read -r l; do [ -n "$l" ] && add "$l"; done < <(printf '%s\n' "${parsed:-}" | grep '^lims_ops_' || true)
else
  rc=1
fi
read -r _ arch_id arch_max repo2_ok <<< "${repo2_line:-REPO2 - - 0}"

# --- repo2 newest WAL time from `repo-ls --repo=2` (not repo1, not the check time; AC-12.2)
newest_time=""
if [ "$arch_id" != "-" ] && [ "$arch_max" != "-" ]; then
  if ls_json=$(pgbackrest --stanza=lims --repo=2 --output=json repo-ls \
      "archive/lims/$arch_id/${arch_max:0:16}" 2>/dev/null); then
    newest_time=$(printf '%s' "$ls_json" | "$PY" -c '
import json, sys
seg, d = sys.argv[1], json.load(sys.stdin)
f = {k: v for k, v in d.items() if isinstance(v, dict) and v.get("type") == "file" and "time" in v}
hit = [v["time"] for k, v in f.items() if k.startswith(seg)]
t = max(hit) if hit else max((v["time"] for v in f.values()), default=None)
if t is not None:
    print(int(t))
' "$arch_max" 2>/dev/null | tr -d '\r')
  fi
fi
cache="$state_dir/repo2_newest_wal_time"
if [[ "$newest_time" =~ ^[0-9]+$ ]]; then
  [ -d "$state_dir" ] && { echo "$newest_time" > "$cache.tmp" && mv "$cache.tmp" "$cache"; } 2>/dev/null
else
  rc=1
  # unknown now: the last proven arrival only gets older, so its age is the safe value
  newest_time=$(cat "$cache" 2>/dev/null || true)
fi
[[ "$newest_time" =~ ^[0-9]+$ ]] && add "lims_ops_wal_repo2_newest_age_seconds $((now - newest_time))"

# --- WAL not yet archived: current LSN - end LSN of pg_stat_archiver.last_archived_wal (16 MiB segments)
seg=$(psql -XAtq -U supabase_admin -d postgres -c "select last_archived_wal from pg_stat_archiver" 2>/dev/null \
  | tr -d '\r[:space:]') || seg=""
lsn="0/0"
if [[ "$seg" =~ ^[0-9A-F]{24}$ ]]; then
  end=$(( (16#${seg:8:8} << 32) + (16#${seg:16:8} + 1) * 16777216 ))
  lsn=$(printf '%X/%X' $((end >> 32)) $((end & 0xFFFFFFFF)))
fi
unarch=$(psql -XAtq -U supabase_admin -d postgres \
  -c "select greatest(0, pg_wal_lsn_diff(pg_current_wal_lsn(), '$lsn'))::bigint" 2>/dev/null | tr -d '\r[:space:]')
if [[ "$unarch" =~ ^[0-9]+$ ]]; then add "lims_ops_wal_unarchived_bytes $unarch"; else rc=1; fi

# --- consecutive failed `check` runs (written by lims-pgbackrest-check.sh)
fails=$(cat "$state_dir/check_consecutive_failures" 2>/dev/null || true)
[[ "$fails" =~ ^[0-9]+$ ]] && checked=1 || { fails=0; checked=0; }
add "lims_ops_wal_check_consecutive_failures $fails"
# 1 only while repo2 (site B) is configured, healthy in `info`, and the last check passed (08 A25 D-210)
offsite=0
[ "$repo2_ok" = 1 ] && [ "$checked" = 1 ] && [ "$fails" = 0 ] && offsite=1
add "lims_ops_offsite_archive_configured $offsite"

if [ -n "${TEXTFILE_DIR:-}" ]; then
  printf '%s' "$out" > "$TEXTFILE_DIR/pgbackrest.prom.tmp" && mv "$TEXTFILE_DIR/pgbackrest.prom.tmp" "$TEXTFILE_DIR/pgbackrest.prom" || rc=1
else
  printf '%s' "$out"
fi
exit "$rc"

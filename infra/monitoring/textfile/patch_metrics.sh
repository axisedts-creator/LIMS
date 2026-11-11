#!/usr/bin/env bash
# patch_metrics.sh - 02-TRD s13 / s15 textfile metric (every 5 min, every host, root).
# Exports lims_ops_last_patch_timestamp_seconds (no labels; the scrape adds `host`) from
# $STATE_DIR/last_patch_timestamp (default /var/lib/lims/patch), written by playbooks/patch.yml.
# Output: $TEXTFILE_DIR/patch.prom (atomic) or stdout when TEXTFILE_DIR is unset.
# Fail closed (exit 1, no sample): stamp missing, empty, not a plain positive integer, or more
# than 300 s in the future. A stale patch.prom is removed. Only the first line is read and it
# is data, never evaluated.
set -u
state_dir=${STATE_DIR:-/var/lib/lims/patch}
out_dir=${TEXTFILE_DIR:-}
now=$(date +%s)

fail() {
  echo "patch_metrics: $1" >&2
  if [ -n "$out_dir" ]; then rm -f "$out_dir/patch.prom"; fi
  exit 1
}

line=""
IFS= read -r line < "$state_dir/last_patch_timestamp" 2>/dev/null || [ -n "$line" ] || fail "stamp missing or empty"
[[ $line =~ ^[1-9][0-9]{0,11}$ ]] || fail "stamp is not a positive integer"
[ "$line" -le $((now + 300)) ] || fail "stamp is in the future"

sample=$(printf '# HELP lims_ops_last_patch_timestamp_seconds Unix time of the last successful patch run.\n# TYPE lims_ops_last_patch_timestamp_seconds gauge\nlims_ops_last_patch_timestamp_seconds %s\n' "$line")
if [ -z "$out_dir" ]; then
  printf '%s\n' "$sample"
  exit 0
fi
tmp=$(mktemp "$out_dir/.patch.prom.XXXXXX") || fail "cannot write $out_dir"
if printf '%s\n' "$sample" > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$out_dir/patch.prom"; then
  exit 0
fi
rm -f "$tmp"
fail "write failed"

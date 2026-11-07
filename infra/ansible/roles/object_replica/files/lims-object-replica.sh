#!/usr/bin/env bash
# Object replica, 02-TRD s9.5 (AC-14.2, AC-14.3; 07-SECURITY A3).
#   sync   (default): copy new objects to the DR replica. --ignore-existing
#          and NO delete flag: a deletion or ransomware overwrite on the
#          primary never reaches the replica (Storage objects are immutable).
#   verify (nightly): full --checksum dry-run; reports replica objects whose
#          content differs (silent corruption). Read-only, never repairs.
# Env: REPLICA_SRC, REPLICA_DEST, TEXTFILE_DIR, REPLICA_SSH_KEY,
#      REPLICA_KNOWN_HOSTS. REPLICA_DEST has no default host [CONV]: the
#      systemd unit sets it from the inventory (LD-45, no host names here).
set -euo pipefail

mode=${1:-sync}
case "$mode" in
  sync|verify) ;;
  *) echo "usage: $0 [sync|verify]" >&2; exit 2 ;;
esac

SRC=${REPLICA_SRC:-/srv/lims/storage/}
SRC="${SRC%/}/"
DEST=${REPLICA_DEST:-}
[ -n "$DEST" ] || { echo "REPLICA_DEST is not set" >&2; exit 2; }
TEXTFILE_DIR=${TEXTFILE_DIR:-/var/lib/node_exporter/textfile}
KEY=${REPLICA_SSH_KEY:-/run/lims/secrets/object_replica/ssh_key}
KNOWN=${REPLICA_KNOWN_HOSTS:-/etc/lims/object_replica_known_hosts}

SSH="ssh -p 2222 -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN"
# 02-TRD s9.5 lists a bare partial flag; we use --partial-dir instead (CR .orchestra/cr/T-11.md).
# With --ignore-existing, a half file kept under its final name is skipped forever.
# --partial-dir keeps the half file in a side dir and still resumes (03-APP-FLOW: partial transfer resumes).
FLAGS=(-a --ignore-existing --partial-dir=.rsync-partial --checksum-choice=xxh128 -e "$SSH")

if [ "$mode" = verify ]; then
  # No --ignore-existing here: existing files must be compared.
  out=$(rsync -a --checksum --dry-run --itemize-changes \
          --checksum-choice=xxh128 -e "$SSH" "$SRC" "$DEST")
  # %i = YXcstpoguax; 3rd char `c` = content differs on a file on both sides.
  # Files missing on the replica (`>f+++`) are lag, not corruption.
  bad=$(printf '%s\n' "$out" | awk 'substr($1, 2, 1) == "f" && substr($1, 3, 1) == "c"')
  if [ -n "$bad" ]; then
    echo "object replica checksum mismatch:" >&2
    printf '%s\n' "$bad"
    exit 1
  fi
  exit 0
fi

prom="$TEXTFILE_DIR/lims_object_replica.prom"
last_success=$(awk '$1 == "lims_ops_object_replica_last_success_timestamp_seconds" {print $2}' "$prom" 2>/dev/null || true)

rc=0
rsync "${FLAGS[@]}" "$SRC" "$DEST" >/dev/null || rc=$?
now=$(date +%s)
[ "$rc" -eq 0 ] && last_success=$now

# Lag = now - mtime of the newest primary file not yet on the replica.
lag=0
if pending=$(rsync "${FLAGS[@]}" --dry-run "--out-format=%i %n" "$SRC" "$DEST"); then
  newest=0
  while IFS= read -r line; do
    case "$line" in '>f'*) ;; *) continue ;; esac
    m=$(stat -c %Y -- "$SRC${line#* }" 2>/dev/null) || continue
    [ "$m" -gt "$newest" ] && newest=$m
  done <<< "$pending"
  [ "$newest" -gt 0 ] && lag=$(( now > newest ? now - newest : 0 ))
elif [ -n "$last_success" ]; then
  lag=$(( now - ${last_success%.*} ))  # replica unreachable: age of last success
fi

mkdir -p "$TEXTFILE_DIR"
tmp=$(mktemp "$TEXTFILE_DIR/.lims_object_replica.XXXXXX")
{
  echo "# HELP lims_ops_object_replica_lag_seconds now - mtime of newest object not yet replicated"
  echo "# TYPE lims_ops_object_replica_lag_seconds gauge"
  echo "lims_ops_object_replica_lag_seconds $lag"
  if [ -n "$last_success" ]; then
    echo "# HELP lims_ops_object_replica_last_success_timestamp_seconds last successful replica sync"
    echo "# TYPE lims_ops_object_replica_last_success_timestamp_seconds gauge"
    echo "lims_ops_object_replica_last_success_timestamp_seconds $last_success"
  fi
} > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$prom"

[ "$rc" -eq 0 ] || echo "rsync failed with exit $rc" >&2
exit "$rc"

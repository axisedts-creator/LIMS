#!/usr/bin/env bash
# infra/drill/restore.sh - restore-drill step 2 (02-TRD s9.6, 03-APP-FLOW s4.1, AC-13.1).
# Runs inside the scratch container `drill-pg` (pgbackrest, pg_ctl, pg_isready on PATH), as postgres.
# PITR of repo2 to now - DRILL_TARGET_OFFSET_MIN, start Postgres bound to 127.0.0.1 with archiving and
# replication off (03-APP-FLOW s4.3), poll pg_isready. Measured RTO = restore start -> accepting connections.
# Env: PGDATA (required), DRILL_TARGET_OFFSET_MIN (default 30), DRILL_ACCEPT_TIMEOUT_S (default 7200 = 2 h
# [CONV] 03-APP-FLOW s4.1), DRILL_PG_CONFIG_FILE (optional config_file= of the image).
# The repo2 cipher pass reaches pgbackrest only via its config include on tmpfs - never argv (AC-12.3).
# stdout: target_time=<YYYY-MM-DD HH:MM:SS+00>, rto_seconds=<int> (only when it accepted connections).
set -euo pipefail

offset=${DRILL_TARGET_OFFSET_MIN:-30}
timeout_s=${DRILL_ACCEPT_TIMEOUT_S:-7200}
[[ $offset =~ ^[0-9]{1,5}$ ]] || { echo "restore.sh: DRILL_TARGET_OFFSET_MIN not an integer" >&2; exit 2; }
[[ $timeout_s =~ ^[0-9]{1,6}$ ]] || { echo "restore.sh: DRILL_ACCEPT_TIMEOUT_S not an integer" >&2; exit 2; }
: "${PGDATA:?restore.sh: PGDATA unset}"

t0=$(date -u +%s)
# epoch arithmetic + `date -d @N` also works with busybox date (Alpine-based image)
target=$(date -u -d "@$((t0 - offset * 60))" '+%Y-%m-%d %H:%M:%S')+00
echo "target_time=$target"

pgbackrest --stanza=lims --repo=2 --pg1-path="$PGDATA" --type=time --target="$target" \
  --target-action=promote restore || { echo "restore.sh: pgbackrest restore failed (WAL gap?)" >&2; exit 3; }

opts="-c listen_addresses=127.0.0.1 -c archive_mode=off -c max_wal_senders=0"
[[ -n "${DRILL_PG_CONFIG_FILE:-}" ]] && opts="$opts -c config_file=$DRILL_PG_CONFIG_FILE"
pg_ctl -D "$PGDATA" -l "$PGDATA/drill-pg.log" -W -o "$opts" start \
  || { echo "restore.sh: pg_ctl start failed" >&2; exit 4; }

deadline=$(( $(date -u +%s) + timeout_s ))
until pg_isready -h 127.0.0.1 -q >/dev/null 2>&1; do
  if (( $(date -u +%s) >= deadline )); then
    echo "restore.sh: not accepting connections after ${timeout_s}s" >&2
    exit 5
  fi
  sleep 2
done
echo "rto_seconds=$(( $(date -u +%s) - t0 ))"

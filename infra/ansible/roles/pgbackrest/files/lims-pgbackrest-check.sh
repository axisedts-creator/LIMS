#!/bin/sh
# Managed by Ansible (role pgbackrest) - 02-TRD s9.3/s9.4 archive check (RPO proof).
# Runs `pgbackrest --stanza=lims check` and keeps the consecutive-failure count
# read by pgbackrest_metrics.sh (lims_ops_wal_check_consecutive_failures).
set -u
state=${STATE_DIR:-/var/lib/lims/pgbackrest}/check_consecutive_failures
n=$(cat "$state" 2>/dev/null || echo 0)
case "$n" in '' | *[!0-9]*) n=0 ;; esac
if "${PGBACKREST:-/usr/local/lib/lims/bin/pgbackrest}" --stanza=lims check; then
  n=0; rc=0
else
  n=$((n + 1)); rc=1
fi
echo "$n" > "$state.tmp" && mv "$state.tmp" "$state"
exit "$rc"

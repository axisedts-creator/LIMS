#!/usr/bin/env bash
# Managed by Ansible (role standby, T-12): standby lag textfile metrics for
# node_exporter (02-TRD s9.5, s11 StandbyLagHigh > 60 s). Read-only query.
# Env: TEXTFILE_DIR. `psql` comes from PATH (host wrapper into the standby
# container). LD-45: no host names; runs only where role standby is enabled.
#   lims_ops_standby_up                 1 query ok, 0 psql failed / bad output
#   lims_ops_standby_in_recovery        1 standby, 0 promoted (page-worthy)
#   lims_ops_standby_replay_lag_seconds only when in recovery and known
# Lag = 0 only when everything received is replayed AND the WAL receiver is
# streaming (an idle primary stops advancing the replay timestamp); else
# now() - last replayed commit, so a cut link shows growing lag.
set -u
dir=${TEXTFILE_DIR:?TEXTFILE_DIR not set}
out_file="$dir/lims_standby.prom"

query="SELECT pg_is_in_recovery(),
  CASE WHEN NOT pg_is_in_recovery() THEN NULL
       WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()
            AND EXISTS (SELECT 1 FROM pg_stat_wal_receiver WHERE status = 'streaming') THEN 0
       ELSE round(extract(epoch FROM now() - pg_last_xact_replay_timestamp())::numeric, 3)
  END"

up=0 rec="" lag=""
if res=$(psql -X -w -A -t -F'|' -c "$query" 2>/dev/null); then
  res=$(printf '%s\n' "$res" | head -n 1 | tr -d '\r')
  IFS='|' read -r r l <<<"$res"
  case "$r" in
    t) up=1 rec=1 ;;
    f) up=1 rec=0 ;;
  esac
  if [ "$rec" = 1 ] && [[ "${l:-}" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    lag=$l
  fi
fi

tmp=$(mktemp "$dir/.lims_standby.prom.XXXXXX") || exit 1
trap 'rm -f "$tmp"' EXIT
{
  echo "# HELP lims_ops_standby_up 1 if the standby answered the lag query."
  echo "# TYPE lims_ops_standby_up gauge"
  echo "lims_ops_standby_up $up"
  echo "# HELP lims_ops_standby_in_recovery 1 if the standby is in recovery (0 = promoted)."
  echo "# TYPE lims_ops_standby_in_recovery gauge"
  [ -n "$rec" ] && echo "lims_ops_standby_in_recovery $rec"
  echo "# HELP lims_ops_standby_replay_lag_seconds Seconds since the last replayed commit (0 when caught up and streaming)."
  echo "# TYPE lims_ops_standby_replay_lag_seconds gauge"
  [ -n "$lag" ] && echo "lims_ops_standby_replay_lag_seconds $lag"
} >"$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$out_file"
trap - EXIT
exit 0

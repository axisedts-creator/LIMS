#!/usr/bin/env bash
# Managed by Ansible (role auditstore, T-15): audit shipping textfile metrics
# for node_exporter (02-TRD s10.3, s11 AuditShippingLagging > 300 s,
# AuditShippingDown; AC-18.2). Read-only query as lims_monitor in the store
# database. Env: TEXTFILE_DIR; psql from PATH (host wrapper into the store
# container, credentials from the unit environment). LD-45: no host names.
#   lims_ops_auditstore_up                    1 query ok, 0 psql failed / no subscription / bad output
#   lims_ops_auditstore_subscription_enabled  1 enabled, 0 disabled (page)
#   lims_ops_auditstore_lag_seconds           only when known; never 0 for unknown
# Lag: apply worker running => now() - latest_end_time (last position the
# publisher confirmed; keepalives refresh it on an idle primary, so a healthy
# idle night stays low). Worker not running => now() - newest replicated
# occurred_at (loose index scan over the PK per tenant), so a stopped
# subscription shows growing lag.
set -u
dir=${TEXTFILE_DIR:?TEXTFILE_DIR not set}
out_file="$dir/lims_auditstore.prom"

query="SELECT s.subenabled,
  round(greatest(0, extract(epoch FROM now() - coalesce(
    (SELECT st.latest_end_time FROM pg_stat_subscription st
      WHERE st.subid = s.oid AND st.pid IS NOT NULL AND st.relid IS NULL),
    (WITH RECURSIVE t(id) AS (
       SELECT min(tenant_id) FROM audit.audit_log
       UNION ALL
       SELECT (SELECT min(a.tenant_id) FROM audit.audit_log a WHERE a.tenant_id > t.id) FROM t WHERE t.id IS NOT NULL)
     SELECT max((SELECT max(a.occurred_at) FROM audit.audit_log a WHERE a.tenant_id = t.id)) FROM t))))::numeric, 3)
FROM pg_subscription s
WHERE s.subname = 'audit_ship'
  AND s.subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())"

up=0 en="" lag=""
if res=$(psql -X -w -A -t -F'|' -c "$query" 2>/dev/null); then
  res=$(printf '%s\n' "$res" | head -n 1 | tr -d '\r')
  IFS='|' read -r e l <<<"$res"
  case "$e" in
    t) up=1 en=1 ;;
    f) up=1 en=0 ;;
  esac
  if [ -n "$en" ] && [[ "${l:-}" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    lag=$l
  fi
fi

tmp=$(mktemp "$dir/.lims_auditstore.prom.XXXXXX") || exit 1
trap 'rm -f "$tmp"' EXIT
{
  echo "# HELP lims_ops_auditstore_up 1 if the audit store answered the shipping query."
  echo "# TYPE lims_ops_auditstore_up gauge"
  echo "lims_ops_auditstore_up $up"
  echo "# HELP lims_ops_auditstore_subscription_enabled 1 if subscription audit_ship is enabled."
  echo "# TYPE lims_ops_auditstore_subscription_enabled gauge"
  [ -n "$en" ] && echo "lims_ops_auditstore_subscription_enabled $en"
  echo "# HELP lims_ops_auditstore_lag_seconds Audit shipping lag in seconds (absent when unknown)."
  echo "# TYPE lims_ops_auditstore_lag_seconds gauge"
  [ -n "$lag" ] && echo "lims_ops_auditstore_lag_seconds $lag"
} >"$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$out_file"
trap - EXIT
exit 0

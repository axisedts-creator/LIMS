#!/usr/bin/env bash
# Managed by Ansible (role auditstore, T-15): nightly digest chain
# (REQ-SEC-097, 05-SCHEMA s3.4). Runs digest.sql as audit_digest (PGUSER and
# password from the unit environment; psql from PATH = host wrapper into the
# store container), then publishes the mismatch counter for node_exporter:
#   lims_ops_audit_digest_mismatch_total  digest_mismatch rows in
#   auditstore_meta.ops_audit (append-only table => monotonic counter).
# Env: DIGEST_SQL, LIMS_ENV (dev|staging|prod), TEXTFILE_DIR.
set -euo pipefail
dir=${TEXTFILE_DIR:?TEXTFILE_DIR not set}
sql=${DIGEST_SQL:?DIGEST_SQL not set}
env=${LIMS_ENV:?LIMS_ENV not set}

n=$(psql -X -w -q -A -t -v ON_ERROR_STOP=1 -v env="$env" -f - <"$sql" | tail -n 1 | tr -d '\r')
if ! [[ "$n" =~ ^[0-9]+$ ]]; then
  echo "lims-auditstore-digest: unexpected digest.sql output" >&2
  exit 1
fi

tmp=$(mktemp "$dir/.lims_auditstore_digest.prom.XXXXXX")
trap 'rm -f "$tmp"' EXIT
{
  echo "# HELP lims_ops_audit_digest_mismatch_total Audit digest re-verification mismatches recorded in ops_audit."
  echo "# TYPE lims_ops_audit_digest_mismatch_total counter"
  echo "lims_ops_audit_digest_mismatch_total $n"
} >"$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$dir/lims_auditstore_digest.prom"
trap - EXIT

#!/usr/bin/env bash
# lims_ops_scanner_signature_age_seconds, 02-TRD s7.4 / s11.3 (T-22, AC-28.2). Runs on the app host (timer).
# Value = now - build time of the NEWEST of main/daily/bytecode .cvd/.cld in the copy clamd reads.
# Build time = CVD header field 9 (stime, epoch) or, if absent, field 2 (`DD Mon YYYY HH-MM +ZZZZ`).
# Fail closed: no readable database -> exit 1 and the metric is written as 1 year (alert ScannerSignaturesStale
# fires); a missing metric must never hide staleness. Never negative (clock skew / forged header).
# Env: CLAMAV_DB_DIR (default /srv/lims/clamav-db), TEXTFILE_DIR (default /var/lib/node_exporter/textfile).
set -euo pipefail

DB=${CLAMAV_DB_DIR:-/srv/lims/clamav-db}
TEXTFILE_DIR=${TEXTFILE_DIR:-/var/lib/node_exporter/textfile}
METRIC=lims_ops_scanner_signature_age_seconds
UNKNOWN=31536000

build_time() {  # $1 file -> epoch on stdout, or return 1 (not a CVD/CLD header)
  local h d st t
  h=$(head -c 512 -- "$1" 2>/dev/null | tr -d '\0') || return 1
  case "$h" in ClamAV-VDB:*) ;; *) return 1 ;; esac
  IFS=: read -r _ d _ _ _ _ _ _ st _ <<< "$h"
  if [[ "$st" =~ ^[0-9]{1,11}$ ]]; then
    t=$st
  else
    t=$(date -u -d "${d/-/:}" +%s 2>/dev/null) || return 1
  fi
  printf '%s\n' "$t"
}

shopt -s nullglob
newest=0
for f in "$DB"/{main,daily,bytecode}.{cvd,cld}; do
  t=$(build_time "$f") || continue
  [ "$t" -gt "$newest" ] && newest=$t
done

now=$(date +%s)
rc=0
if [ "$newest" -gt 0 ]; then
  age=$(( now > newest ? now - newest : 0 ))
else
  age=$UNKNOWN
  rc=1
  echo "no readable ClamAV database in $DB; reporting age $UNKNOWN" >&2
fi

mkdir -p "$TEXTFILE_DIR"
tmp=$(mktemp "$TEXTFILE_DIR/.lims_clamav.XXXXXX")
trap 'rm -f "$tmp"' EXIT
{
  echo "# HELP $METRIC now - build time of the newest ClamAV database clamd reads"
  echo "# TYPE $METRIC gauge"
  echo "$METRIC $age"
} > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$TEXTFILE_DIR/lims_clamav.prom"
exit "$rc"

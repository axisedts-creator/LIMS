#!/usr/bin/env bash
# infra/drill/report.sh - restore-drill step 5 (02-TRD s9.6, 03-APP-FLOW s4.1, AC-13.1).
# Writes TEXTFILE_DIR/restore_drill.prom atomically (metrics first), then a Markdown report
# DRILL_LOG_DIR/<YYYY-MM-DD>-restore-drill.md, then (unless DRILL_SKIP_PR=1) a PR from DRILL_REPO_DIR
# via `gh pr create` on a drill/* branch - main is never pushed.
# Counts and timings only (07-SEC control 2). Every input is validated; an invalid value is dropped
# (metric omitted, "invalid" in the report), never interpolated into code or the exposition format.
# lims_ops_restore_drill_last_success_timestamp_seconds: refreshed only on `succeeded` with 0 failed
# checks; otherwise the previous value is carried over (else RestoreDrillOverdue could never fire).
# failed/aborted: lims_ops_restore_drill_checks_failed is at least 1 [CONV], so RestoreDrillFailed
# (T-19, "failed/aborted or checks_failed > 0") can key on one metric.
# Exit: 0 ok; 2 bad DRILL_STATE (nothing written); 3 metrics+report written but the PR failed.
set -euo pipefail

state=${DRILL_STATE:-}
case "$state" in
  succeeded|succeeded_with_failures|failed|aborted) ;;
  *) echo "report.sh: unknown DRILL_STATE" >&2; exit 2 ;;
esac
: "${TEXTFILE_DIR:?report.sh: TEXTFILE_DIR unset}"
: "${DRILL_LOG_DIR:?report.sh: DRILL_LOG_DIR unset}"

valid() {  # valid <regex> <value>: echo the value if it matches, else nothing
  [[ $2 =~ $1 ]] && printf '%s' "$2" || true
}
INT='^[0-9]{1,12}$'
rto=$(valid "$INT" "${DRILL_RTO_SECONDS:-}")
total=$(valid "$INT" "${DRILL_CHECKS_TOTAL:-}")
failed=$(valid "$INT" "${DRILL_CHECKS_FAILED:-}")
sampled=$(valid "$INT" "${DRILL_OBJECTS_SAMPLED:-}")
mism=$(valid "$INT" "${DRILL_OBJECTS_MISMATCHED:-}")
lsn=$(valid '^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$' "${DRILL_VERIFIED_LSN:-}")
target=$(valid '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' \
  "${DRILL_TARGET_TIME:-}")

if [[ $state == failed || $state == aborted ]] && (( ${failed:-0} < 1 )); then failed=1; fi

now=$(date -u +%s)
prom="$TEXTFILE_DIR/restore_drill.prom"
M=lims_ops_restore_drill_last_success_timestamp_seconds
if [[ $state == succeeded && $failed == 0 ]]; then
  last=$now
else
  last=$(sed -n "s/^$M \([0-9][0-9.eE+]*\)\$/\1/p" "$prom" 2>/dev/null | head -n1 || true)
fi

mkdir -p "$TEXTFILE_DIR"
tmp=$(mktemp "$TEXTFILE_DIR/.restore_drill.prom.XXXXXX")
{
  echo "# HELP $M Unix time of the last restore drill that succeeded with no failed check."
  echo "# TYPE $M gauge"
  if [[ -n $last ]]; then echo "$M $last"; fi
  echo "# HELP lims_ops_restore_drill_rto_seconds Measured RTO of the last drill (restore start to accepting connections)."
  echo "# TYPE lims_ops_restore_drill_rto_seconds gauge"
  if [[ -n $rto ]]; then echo "lims_ops_restore_drill_rto_seconds $rto"; fi
  echo "# HELP lims_ops_restore_drill_checks_failed Failed checks of the last drill."
  echo "# TYPE lims_ops_restore_drill_checks_failed gauge"
  if [[ -n $failed ]]; then echo "lims_ops_restore_drill_checks_failed $failed"; fi
} > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$prom"

day=$(date -u +%F)
mkdir -p "$DRILL_LOG_DIR"
md="$DRILL_LOG_DIR/$day-restore-drill.md"
v() { printf '%s' "${1:-invalid/absent}"; }
cat > "$md" <<EOF
# Restore drill $day

Counts and timings only (07-SEC control 2). 02-TRD s9.6, AC-13.1.

| Item | Value |
|---|---|
| State | $state |
| Target time (PITR, repo2) | $(v "$target") |
| Measured RTO (s) | $(v "$rto") |
| Verified LSN | $(v "$lsn") |
| Checks total / failed | $(v "$total") / $(v "$failed") |
| Objects sampled / mismatched | $(v "$sampled") / $(v "$mism") |
| Report written (UTC) | $(date -u +%Y-%m-%dT%H:%M:%SZ) |
EOF
echo "report.sh: metrics and report written (state $state)" >&2

[[ "${DRILL_SKIP_PR:-}" == 1 ]] && exit 0
: "${DRILL_REPO_DIR:?report.sh: DRILL_REPO_DIR unset}"
branch="drill/$(date -u +%Y%m%d-%H%M%S)"
if (
  cd "$DRILL_REPO_DIR"
  git fetch origin main
  git checkout -b "$branch" origin/main
  git add -- "$md"
  git commit -m "drill-log: restore drill $day ($state)"
  git push origin "$branch"
  gh pr create --head "$branch" --title "Restore drill $day: $state" \
    --body "Automated restore drill report (02-TRD s9.6). Counts and timings only."
); then
  exit 0
fi
echo "report.sh: report PR failed (metrics and report are written)" >&2
exit 3

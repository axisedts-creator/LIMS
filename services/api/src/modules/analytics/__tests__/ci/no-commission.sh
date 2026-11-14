#!/usr/bin/env bash
# CI gate c8-no-commission (CR-C8-015, 02-TRD §13, PRD US-07.3, 08 A17 D-44 / 07-BLOCKERS B13: "no payout features").
# Fails (exit 1) when the word below appears, case-insensitively, in the content or in the NAME of any file under the C8 paths.
# Directories named __tests__ are skipped: tests legitimately assert that the word is absent. Missing paths are skipped.
# Usage: no-commission.sh [REPO_ROOT]   (default: the repo this script lives in). Exit 0 clean, 1 violation, 2 usage/tool error.
set -u
ROOT="${1:-$(cd "$(dirname "$0")/../../../../../../.." && pwd)}"
cd "$ROOT" || { echo "no-commission: cannot cd to $ROOT" >&2; exit 2; }
WORD='commission'
PATHS=(
  "services/api/src/modules/analytics"
  "services/worker/src/jobs/analytics"
  "apps/web/src/features/analytics"
  "apps/web/src/app/(staff)/analytics"
  "docs/manual/analytics"
  "services/renderer/templates/analytics"
)
bad=0
for p in "${PATHS[@]}"; do
  [ -d "$p" ] || continue
  names=$(find "$p" \( -name node_modules -o -name __tests__ \) -prune -o -iname "*${WORD}*" -print) || exit 2
  if [ -n "$names" ]; then printf 'no-commission: file name: %s\n' $names; bad=1; fi
  hits=$(grep -rIil --exclude-dir=__tests__ --exclude-dir=node_modules -e "$WORD" -- "$p")
  rc=$?
  if [ $rc -eq 0 ]; then printf 'no-commission: content: %s\n' $hits; bad=1; elif [ $rc -ne 1 ]; then echo "no-commission: grep failed on $p" >&2; exit 2; fi
done
[ $bad -eq 0 ] && echo "no-commission: clean" && exit 0
echo "no-commission: remove the word from the files above (PRD US-07.3)" >&2
exit 1

#!/usr/bin/env bash
# CI gate c8-no-commission (CR-C8-015, 02-TRD §13, PRD US-07.3, 08 A17 D-44 / 07-BLOCKERS B13: "no payout features"; LD-342 / A39-6f allow list).
# Fails (exit 1) when the word below appears, case-insensitively, in the content or in the NAME of any file under the C8 paths, EXCEPT the files named in
# no-commission.allow next to this script: exact repo-relative paths, one per line, "#" starts a comment, no globs, no directories, no "..", no absolute paths.
# An allowed path is exempt for both its content and its name; nothing else is (the allow list is reviewed in every diff).
# Directories named __tests__ are skipped: tests legitimately assert that the word is absent. Missing paths are skipped.
# Usage: no-commission.sh [REPO_ROOT]   (default: the repo this script lives in). Exit 0 clean, 1 violation, 2 usage/tool error (incl. a malformed allow list).
set -u
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${1:-$(cd "$SELF_DIR/../../../../../../.." && pwd)}"
ALLOW_FILE="$SELF_DIR/no-commission.allow"
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

ALLOWED=()
if [ -f "$ALLOW_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
    case "$line" in '' | '#'*) continue ;; esac
    case "$line" in
      /* | *..* | *'*'* | *'?'* | */) echo "no-commission: bad allow list entry '$line' (exact repo-relative file paths only)" >&2; exit 2 ;;
    esac
    ALLOWED+=("$line")
  done < "$ALLOW_FILE"
fi
is_allowed() { local p="$1" a; for a in "${ALLOWED[@]+"${ALLOWED[@]}"}"; do [ "$a" = "$p" ] && return 0; done; return 1; }

bad=0
report() { # $1 kind, stdin: one path per line
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    is_allowed "$f" && continue
    printf 'no-commission: %s: %s\n' "$1" "$f"; bad=1
  done
}
for p in "${PATHS[@]}"; do
  [ -d "$p" ] || continue
  names=$(find "$p" \( -name node_modules -o -name __tests__ \) -prune -o -iname "*${WORD}*" -print) || exit 2
  report "file name" <<< "$names"   # here-string, not a pipe: report must run in this shell to set bad
  hits=$(grep -rIil --exclude-dir=__tests__ --exclude-dir=node_modules -e "$WORD" -- "$p")
  rc=$?
  if [ $rc -eq 0 ]; then report content <<< "$hits"; elif [ $rc -ne 1 ]; then echo "no-commission: grep failed on $p" >&2; exit 2; fi
done
[ $bad -eq 0 ] && echo "no-commission: clean" && exit 0
echo "no-commission: remove the word from the files above or, for the two A39 report definitions only, add the exact path to no-commission.allow (PRD US-07.3)" >&2
exit 1

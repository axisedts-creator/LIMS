#!/usr/bin/env bash
# CI job `c3-wording-commission` (02-TRD §13 "CI jobs for C0-0A", wired through CR-C3-009; 07-SECURITY S-17; PRD AC-11.5; 04 L19).
# Fails (exit 1) when the word "commission" (any case) appears in a C3 path. Exit 0 = clean, 2 = misconfiguration (no trigger path exists).
# Scope: the five trigger paths of the TRD table. Test files and __tests__ trees are excluded: they legitimately quote the forbidden word
# (ci/wording.ci.test.ts plants it on purpose). Template texts live in services/worker/src/jobs/catalog/xlsx/templates/*.ts and are covered.
# The repository root is derived from this file's location (7 levels up), so the job works from any working directory.
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../../../.." && pwd)" || exit 2
cd "$root" || exit 2
paths=(
  "services/api/src/modules/catalog"
  "services/worker/src/jobs/catalog"
  "apps/web/src/features/catalog"
  "apps/web/src/app/(staff)/catalog"
  "docs/manual/catalog"
)
existing=()
for p in "${paths[@]}"; do [ -e "$p" ] && existing+=("$p"); done
if [ "${#existing[@]}" -eq 0 ]; then echo "wording-grep: none of the trigger paths exists under $root" >&2; exit 2; fi
if grep -rniI --exclude-dir=__tests__ --exclude-dir=node_modules --exclude='*.test.*' --exclude='*.spec.*' -e commission -- "${existing[@]}"; then
  echo "wording-grep: FAIL — the word 'commission' must not appear in C3 (PRD AC-11.5, 04 L19)" >&2
  exit 1
fi
exit 0

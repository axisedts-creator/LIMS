#!/usr/bin/env bash
# infra/drill/objects_sample.sh - restore-drill step 4 (02-TRD s9.6, AC-14.3): OBJ_SAMPLE_N (default 200)
# random files of the Storage tree (SRC_ROOT), sha256 at the source and at the object replica (REPLICA_ROOT);
# all must match, a missing replica file is a mismatch.
# SRC_SSH / REPLICA_SSH: optional command prefix (e.g. "ssh -o BatchMode=yes user@host"); empty = local.
# File names never reach a shell as code: the list travels NUL-separated on stdin, the remote command
# is printf %q-quoted (the remote login shell must be bash). Output: counts only (07-SEC control 2).
# OBJ_SAMPLE_OUT (optional): file receiving one sampled relative path per line.
# stdout: objects_sampled=<n> objects_mismatched=<n>; exit 1 when mismatched > 0.
set -euo pipefail

: "${SRC_ROOT:?objects_sample.sh: SRC_ROOT unset}"
: "${REPLICA_ROOT:?objects_sample.sh: REPLICA_ROOT unset}"
n=${OBJ_SAMPLE_N:-200}
[[ $n =~ ^[0-9]{1,6}$ ]] || { echo "objects_sample.sh: OBJ_SAMPLE_N not an integer" >&2; exit 2; }

# one line per NUL-terminated relative path on stdin: hex sha256, or MISSING
HASH='cd -- "$1" || exit 3
while IFS= read -r -d "" f; do
  if h=$(sha256sum < "./$f" 2>/dev/null); then printf "%s\n" "${h%% *}"; else echo MISSING; fi
done'

on() {  # on <prefix> <cmd...>: run locally, or via the prefix with every word quoted
  local prefix=$1; shift
  if [[ -z "$prefix" ]]; then "$@"; else $prefix "$(printf '%q ' "$@")"; fi
}

list=$(mktemp); trap 'rm -f "$list"' EXIT
on "${SRC_SSH:-}" find "$SRC_ROOT" -type f -printf '%P\0' | shuf -z -n "$n" > "$list"

mapfile -d '' files < "$list"
mapfile -t src < <(on "${SRC_SSH:-}" bash -c "$HASH" _ "$SRC_ROOT" < "$list")
mapfile -t rep < <(on "${REPLICA_SSH:-}" bash -c "$HASH" _ "$REPLICA_ROOT" < "$list")

bad=0
for i in "${!files[@]}"; do
  s=${src[$i]:-MISSING}; r=${rep[$i]:-MISSING}
  if [[ $s == MISSING || $r == MISSING || $s != "$r" ]]; then bad=$((bad + 1)); fi
done
if [[ -n "${OBJ_SAMPLE_OUT:-}" ]]; then
  printf '%s\n' "${files[@]+"${files[@]}"}" > "$OBJ_SAMPLE_OUT"
fi
echo "objects_sampled=${#files[@]}"
echo "objects_mismatched=$bad"
(( bad == 0 ))

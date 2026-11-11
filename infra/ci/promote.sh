#!/usr/bin/env bash
# infra/ci/promote.sh <from> <to> - promote a smoke-verified release between environments (02-TRD s12.1, AC-20.2).
#   Only dev -> staging and staging -> prod. Copies <from>.deployed.lock.yaml (the digests that passed smoke
#   in <from>) to <to>.lock.yaml with `env: <to>`: the bits verified in staging are the bits that reach prod.
#   Moves digests only: no build, push or deploy. Missing/invalid deployed lock or other pair -> exit != 0, nothing written.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PROG=promote.sh
. "$HERE/lib-deploy.sh"

[ $# -eq 2 ] || die "usage: promote.sh <dev|staging> <staging|prod>"
from=$1; to=$2
check_env "$from"; check_env "$to"
case "$from>$to" in dev\>staging|staging\>prod) ;; *) die "only dev->staging and staging->prod: $from->$to" ;; esac

src="$REL_DIR/$from.deployed.lock.yaml"
read_lock "$src" "$from"
tmp=$(mktemp "$REL_DIR/.$to.promote.XXXXXX")
trap 'rm -f "$tmp"' EXIT
sed "s/^env: .*/env: $to/" "$src" > "$tmp"
mv -f "$tmp" "$REL_DIR/$to.lock.yaml"
echo "$PROG: $from digests recorded as $to.lock.yaml"

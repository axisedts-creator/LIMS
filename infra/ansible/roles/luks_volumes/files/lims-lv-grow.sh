#!/usr/bin/env bash
# Grow an LV and its filesystem online (02-TRD s5.3, AC-14.1).
# Usage: lims-lv-grow.sh <vg>/<lv> <size>
#   size: lvextend -L form (+100G, 500G) or -l form (+100%FREE, +50%VG).
# lvextend -r runs xfs_growfs/resize2fs on the mounted filesystem: no
# unmount, no deactivation, no downtime. Shrinking is refused.
set -euo pipefail

usage() { echo "usage: $0 <vg>/<lv> <+size|+N%FREE>" >&2; exit 2; }
[ "$#" -eq 2 ] || usage
spec=$1 size=$2

name='[A-Za-z0-9_][A-Za-z0-9_+.-]*'
[[ "$spec" =~ ^${name}/${name}$ ]] || { echo "bad LV spec: $spec" >&2; usage; }

if [[ "$size" =~ ^\+?[0-9]+(\.[0-9]+)?[bBsSkKmMgGtTpPeE]?$ ]]; then
  opt=-L
elif [[ "$size" =~ ^\+?[0-9]+%(FREE|VG|PVS|ORIGIN)$ ]]; then
  opt=-l
else
  echo "bad size: $size" >&2; usage
fi

exec lvextend "$opt" "$size" --resizefs "/dev/$spec"

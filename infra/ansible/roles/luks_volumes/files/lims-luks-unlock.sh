#!/usr/bin/env bash
# lims-luks-unlock (02-TRD s5.3, REQ-SEC-125). Run by lims-luks-unlock.service.
# Per volume: fetch the age-encrypted key from ops-1 over wg0 into tmpfs
# (/run/lims-luks), decrypt it with the host age identity straight into
# cryptsetup (the plain key never touches a disk), then activate the VG and
# mount. If ops-1 is unreachable or the key is rejected, fall back to the
# console: systemd-ask-password asks the ops engineer for the passphrase.
# Config: /etc/lims/luks/unlock.conf (KEY_URL, CA_CERT, AGE_IDENTITY, VOLUMES).
set -u
umask 077
# shellcheck source=/dev/null
. /etc/lims/luks/unlock.conf
RUN=/run/lims-luks
mkdir -p "$RUN"
rc=0

fetch_unlock() {  # $1 mapper name, $2 device
  [ -n "${KEY_URL:-}" ] || return 1
  curl -fsS --max-time 15 --retry 3 --cacert "$CA_CERT" \
    -o "$RUN/$1.age" "$KEY_URL/$1.age" || return 1
  age -d -i "$AGE_IDENTITY" "$RUN/$1.age" | cryptsetup open --type luks2 --key-file - "$2" "$1"
}

console_unlock() {  # $1 mapper name, $2 device
  local try
  for try in 1 2 3; do
    systemd-ask-password --timeout=0 "LUKS passphrase for $1 ($2), try $try:" \
      | cryptsetup open --type luks2 "$2" "$1" && return 0
  done
  return 1
}

for v in "${VOLUMES[@]}"; do
  read -r name dev vg lv mnt <<<"$v"
  if [ ! -e "/dev/mapper/$name" ]; then
    if fetch_unlock "$name" "$dev"; then
      echo "$name: unlocked with the key from ops-1"
    else
      echo "$name: ops-1 key unavailable; fallback to console passphrase" >&2
      console_unlock "$name" "$dev" || { echo "$name: unlock failed" >&2; rc=1; }
    fi
    rm -f "$RUN/$name.age"
  fi
  [ -e "/dev/mapper/$name" ] || continue
  vgchange -ay "$vg" >/dev/null || rc=1
  mountpoint -q "$mnt" || mount "/dev/$vg/$lv" "$mnt" || rc=1
done
exit "$rc"

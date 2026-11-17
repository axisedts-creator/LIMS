#!/usr/bin/env bash
# ClamAV signature copy, 02-TRD s7.4 (T-22, AC-28.1/28.2). Runs on the ops host after freshclam:
# ONE rsync of the signature databases to the app host, then ONE clamd RELOAD, only after the copy worked.
#   - No --delete and an empty-source guard: a failed freshclam can never wipe the copy clamd uses.
#   - DEST is passed as ONE argument (never through a shell); a remote DEST uses a pinned, non-interactive ssh.
# Env: CLAMAV_DB_DEST (required, e.g. user@wg_ip:/), CLAMAV_RELOAD_CMD (required, run with bash -c, must exit 0),
#      CLAMAV_DB_SRC (default /var/lib/clamav/), CLAMAV_SSH_KEY, CLAMAV_KNOWN_HOSTS, CLAMAV_SSH_PORT.
# Exit: 0 ok, 1 nothing to copy / rsync or reload failed, 2 usage.
set -euo pipefail

DEST=${CLAMAV_DB_DEST:-}
RELOAD=${CLAMAV_RELOAD_CMD:-}
if [ -z "$DEST" ] || [ -z "$RELOAD" ]; then
  echo "CLAMAV_DB_DEST and CLAMAV_RELOAD_CMD are required" >&2
  exit 2
fi
SRC=${CLAMAV_DB_SRC:-/var/lib/clamav/}
SRC="${SRC%/}/"

shopt -s nullglob
dbs=("$SRC"*.cvd "$SRC"*.cld "$SRC"*.cud)
if [ "${#dbs[@]}" -eq 0 ]; then
  echo "no signature database (*.cvd/*.cld/*.cud) in $SRC; nothing copied" >&2
  exit 1
fi

flags=(-a)
case "${DEST%%/*}" in
  *:*)  # remote: host:path (a colon before the first slash)
    KEY=${CLAMAV_SSH_KEY:-/run/lims/secrets/clamav_sync/ssh_key}
    KNOWN=${CLAMAV_KNOWN_HOSTS:-/etc/lims/clamav_sync_known_hosts}
    flags+=(-e "ssh -p ${CLAMAV_SSH_PORT:-22} -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN")
    ;;
esac

rsync "${flags[@]}" "$SRC" "$DEST" >/dev/null || { rc=$?; echo "rsync failed with exit $rc" >&2; exit 1; }
bash -c "$RELOAD" || { rc=$?; echo "clamd reload failed with exit $rc" >&2; exit 1; }

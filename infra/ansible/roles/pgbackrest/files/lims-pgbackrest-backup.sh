#!/bin/sh
# Managed by Ansible (role pgbackrest) - 02-TRD s9.3.
# Usage: lims-pgbackrest-backup.sh --type=full|--type=incr
# Backs up to repo1, then repo2; tries both, fails if either failed.
set -u
case "${1:-}" in
  --type=full | --type=incr) ;;
  *) echo "usage: $0 --type=full|--type=incr" >&2; exit 2 ;;
esac
rc=0
for repo in --repo=1 --repo=2; do
  /usr/local/lib/lims/bin/pgbackrest --stanza=lims backup "$1" "$repo" || rc=1
done
exit "$rc"

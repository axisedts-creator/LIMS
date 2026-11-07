APPROVE

Re-review of `git diff 61f417d..HEAD` (fix commits bb28483, 5f9adda) against the 5 items of the previous CHANGES round:
1. htpasswd now root:101 0440 (`monitoring_uids.ops_nginx: 101`); dir /run/lims/secrets/monitoring 0755 - nginx worker can read it. Fixed.
2. data-host TargetDown inhibition now targets only the s11.3 db family (`alertname=~"PostgresDown|...|PostgresInvalidIndex"`); new test asserts RpoAtRisk/WalArchiveFailing/BackupMissed are not inhibited. Fixed.
3. `internal_ca_issued` registered; `internal_ca_reissued` = list of re-issued leaf names (the block is skipped when nothing is due, so `default([])` covers that); monitoring restarts ops-nginx after "Stack up" when the list contains it; infra/pki/README.md tells T-23 to do the same for registry. Fixed.
4. Private-key regex split in test_t18_monitoring.py; T-01 not weakened. Fixed.
5. ops-note.sh uses SUDO_USER only when EUID 0; non-root forge test added. Fixed.

Ran: `python -m unittest infra.tests.static.test_t18_monitoring infra.tests.static.test_t01_skeleton`: 77 tests OK, 4 skipped (promtool/amtool absent; root-only case).
Still open (not blocking, owned elsewhere or env): exporters on data/app/dr, `origins.*` group_vars, promtool/amtool + live delivery test must run in CI or on the ops VM before done_when is met.

# Backup runbook (`backup`)

Owner C1. One section per alert in `monitoring/rules/backup.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2), except the drill alert `RestoreDrillFailed`, which lives in `drill.md`.
pgBackRest stanza `lims`: repo1 on the local/near site, repo2 at site B (a different provider in profile `lean`, LD-45) with continuous WAL archiving; RPO is 15 min and must not be weakened to save cost. Encryption of both repos stays on.
Commands run as the `postgres` user on the data role host unless stated.

## WalArchiveLagging
Severity: warn   Owner: C1   Last tested: never
**Means:** the newest WAL in the site-B repo is over 10 min old while WAL is waiting to be archived.  **Impact:** none yet; the 15 min RPO is close.
**Check first:** `pgbackrest --stanza=lims info` (newest WAL per repo); `pgbackrest --stanza=lims check`; `psql -c "select archived_count, failed_count, last_failed_time from pg_stat_archiver"`.
**Fix:** 1. Find why archiving is slow or failing: site-B reachability over wg0 (`ping` the backup host), disk space at site B, `journalctl -u postgresql --since -30min | grep -i archive`. 2. Fix the link or space problem; WAL then catches up on its own. 3. Do not run `pg_archivecleanup` by hand.
**Escalate when:** it turns into `RpoAtRisk` -> page applies, see that entry.
**Close-out:** ops log line with cause and catch-up time.

## RpoAtRisk
Severity: page   Owner: C1   Last tested: never
**Means:** the newest WAL in the site-B repo is over 14 min old while WAL waits to be archived; the 15 min RPO is at risk.  **Impact:** SEV2; a loss of the primary now would lose more than 15 min of data.
**Check first:** `pgbackrest --stanza=lims info` and `pg_stat_archiver` as in `WalArchiveLagging`; `df -h` on the WAL volume of the primary.
**Fix:** 1. Restore the archive path to site B first (link, credentials, space). 2. If site B cannot be reached for over 30 min, confirm repo1 is still archiving; record the RPO breach window. 3. DESTRUCTIVE: never disable `archive_mode` or the `archive_command` to "stop the alert".
**Escalate when:** unresolved after 30 min -> secondary on-call and founder (RPO breach).
**Close-out:** ops log line with breach start/end; incident record because RPO was exceeded.

## WalArchiveFailing
Severity: page   Owner: C1   Last tested: never
**Means:** `pgbackrest check` failed twice in a row.  **Impact:** SEV2; WAL may not reach the repos, so point-in-time recovery has a gap.
**Check first:** `pgbackrest --stanza=lims check` (expect `completed successfully`; the error line names the repo); `psql -c "select * from pg_stat_archiver"`.
**Fix:** 1. Read the error: cipher passphrase mismatch (`secrets.md`), repo path missing, permission denied, or site B unreachable. 2. Fix that one cause and run `check` again; then `pgbackrest --stanza=lims backup --type=incr` to confirm a backup works. 3. If `stanza-create` state is lost, stop and escalate; do not recreate the stanza over an existing repo.
**Escalate when:** still failing after 30 min -> secondary on-call.
**Close-out:** ops log line with the failing repo, cause and fix.

## NoOffsiteArchive
Severity: page   Owner: C1   Last tested: never
**Means:** there is no healthy pgBackRest repo on a site other than the primary's.  **Impact:** SEV2; a site loss would lose all data (LD-45: site B is the DR copy).
**Check first:** `pgbackrest --stanza=lims info` (repo2 must be listed and `ok`); `grep repo2 /etc/pgbackrest/pgbackrest.conf` for a configured path.
**Fix:** 1. If repo2 is missing from the config, the host was rebuilt without it: re-run the `pgbackrest` role (`ansible-playbook playbooks/site.yml --limit <host>`). 2. If the site-B host is unreachable, restore access (`WalArchiveLagging` steps 1-2). 3. After repo2 is healthy, force a full backup to repo2: `pgbackrest --stanza=lims --repo=2 --type=full backup`.
**Escalate when:** not fixed within 1 h -> founder.
**Close-out:** ops log line with how long no offsite copy existed.

## BackupMissed
Severity: page   Owner: C1   Last tested: never
**Means:** there has been no successful backup to a repo for over 26 h.  **Impact:** SEV2; the oldest restore point grows and incremental chains may break.
**Check first:** `pgbackrest --stanza=lims info` (last backup per repo); `systemctl list-timers 'lims-pgbackrest-*'`; `journalctl -u lims-pgbackrest-full.service -u lims-pgbackrest-incr.service --since -2d`.
**Fix:** 1. Read the failure in the journal (space, link, lock held by a hung backup). 2. Remove a stale lock only after confirming no `pgbackrest` process runs (`pgrep -a pgbackrest`). 3. Run the missed backup: `systemctl start lims-pgbackrest-full.service` (forcing a full backup; for a single repo, `pgbackrest --stanza=lims --repo=<1|2> --type=full backup`). 4. Check the repo2 full separately; both repos need a recent full.
**Escalate when:** a second night is missed -> secondary on-call.
**Close-out:** ops log line with repo, cause and the new backup label.

## StandbyLagHigh
Severity: warn   Owner: C1   Last tested: never
**Means:** a standby replays more than 60 s behind for 10 min. Only exists in profile `full` (no hot standby in `lean`, LD-45).  **Impact:** a failover would lose recent transactions beyond the lag.
**Check first:** on the standby `psql -c "select now() - pg_last_xact_replay_timestamp()"`; on the primary `psql -c "select client_addr, replay_lag from pg_stat_replication"`.
**Fix:** 1. Check the wg0 link and disk I/O on the standby. 2. A long-running query on the standby with conflicts shows in the log: cancel it. 3. If lag keeps growing, see `db.md#replicationslotwalretained`.
**Escalate when:** lag above 15 min -> secondary on-call (failover assumptions no longer hold).
**Close-out:** ops log line with cause and recovery time.

## ObjectReplicaStale
Severity: page   Owner: C1   Last tested: never
**Means:** the encrypted object-storage replica at site B last succeeded over 1 h ago or lags over 30 min (warn); over 3 h without success pages.  **Impact:** SEV2 at the page level; uploaded reports and attachments are not yet safe at site B.
**Check first:** `systemctl status lims-object-replica.service lims-object-replica.timer`; `journalctl -u lims-object-replica.service --since -3h`.
**Fix:** 1. Read the rsync error (link, space at site B, permission). 2. Fix and start a run: `systemctl start lims-object-replica.service`. 3. The sync never deletes at the target, so a rerun is safe. 4. The nightly checksum pass (`lims-object-replica-verify.service`) confirms integrity afterwards.
**Escalate when:** over 3 h with no cause found -> secondary on-call.
**Close-out:** ops log line with the gap duration and cause.

## RestoreDrillOverdue
Severity: page   Owner: C1   Last tested: never
**Means:** no successful restore drill for more than 35 days (warn); at 40 days it pages (04 I3).  **Impact:** nobody has proof that backups restore; RTO of 4 h is unproven.
**Check first:** `drill.md` section "Reading the drill result"; `systemctl list-timers 'lims-restore-drill*'`; the newest report in `infra/runbooks/drill-log/`.
**Fix:** 1. Run the drill now: `ansible-playbook playbooks/restore-drill.yml`. 2. If the drill itself fails, follow `drill.md#restoredrillfailed`. 3. The drill is never skipped or weakened to clear the alert.
**Escalate when:** the drill fails twice for the same reason -> secondary on-call; treat the backups as unverified.
**Close-out:** ops log line with drill date and result; the drill report is the record.

## Forcing a full backup
Procedure. When: after a repo was rebuilt, after a long outage, before risky maintenance.
1. `pgbackrest --stanza=lims --repo=1 --type=full backup`, then `--repo=2`. Each runs minutes to hours; run in `tmux`.
2. `pgbackrest --stanza=lims info` shows both fulls; the exporter timestamp updates within 5 min.
3. `infra/ci/ops-note.sh "forced full backup repo <n> label <label>"`.

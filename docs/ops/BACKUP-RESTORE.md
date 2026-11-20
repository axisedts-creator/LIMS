# Backup and restore for the own server (T0B-GOLIVE-1, LD-322)

Companion to [GO-LIVE-OWN-SERVER.md](GO-LIVE-OWN-SERVER.md). Extends the object storage backup notes in
[STORAGE.md](STORAGE.md). No secrets, keys or real addresses are written here; every host is a placeholder
(`backup.example.com`, `*.invalid`). The backup location and provider are founder decisions (GO-LIVE section 7).

A restore that was never tested counts as no backup. The restore drill below is run before go live and every quarter.

## 1. Backups

### Database (PostgreSQL 17)

- **Nightly full backup**: a physical base backup (`pg_basebackup`, or a tool such as pgBackRest or WAL-G) every night at
  02:00 NPT, plus a logical `pg_dump` of each database once a week as a second format.
- **Continuous log archive**: WAL archiving on (`archive_mode = on`), each WAL segment shipped to the backup target within
  minutes (`archive_timeout` of 5 minutes at most), so a point in time restore is possible between nightly backups.
- Every backup is checked after it is written (tool verify command, size and checksum) and its age is a monitored alert
  (backup age, GO-LIVE section 4).

### Object storage

- **Object storage replication**: bucket versioning on, and a scheduled mirror (for example `mc mirror` of MinIO, or the
  store's own replication) of the bucket to a second store at least hourly, plus a nightly full mirror.
- The database and the object store are backed up on the same schedule, so a restored row never points at a missing
  file (STORAGE.md). Every object carries its sha256 as `x-amz-meta-sha256`, used to verify the copy.

### Off site copies

- **Encrypted off site copy**: every database backup, WAL segment and object mirror is encrypted before it leaves the
  server (client side encryption in the backup tool, for example AES-256), then copied to a **second location and a
  second provider**: for example one copy on a disk in a second founder office and one in an S3 compatible bucket at a
  different provider. Copying only within the same office or the same provider is not enough.
- The encryption key is held as decided by the founder (credentials decision); a backup that cannot be decrypted is no
  backup, so the key is part of the restore drill.
- Configuration (service files, proxy configuration, firewall rules, without secret values) is kept in the deploy notes
  so a new server can be rebuilt.

## 2. Retention

Retention schedule (default; the legal review of patient data retention in Nepal may lengthen it):

| Copy | Kept |
|---|---|
| Nightly full database backup | 14 daily, then 8 weekly, then 12 monthly |
| WAL archive | long enough to restore to any point in the last 14 days |
| Weekly logical dump | 12 weeks |
| Object storage versions | 30 days of old versions; current objects kept as long as the record they belong to |
| Off site copies | the same as above, in both the second location and the second provider |
| Yearly archive | one encrypted full copy per year, kept for the legal retention period |

Expired copies are removed by the backup tool's retention rules, never by hand.

## 3. Recovery time (RTO) and data loss limits (RPO)

Targets, to be measured by the first restore drill:

- **RTO** (recovery time objective): the API back in service within 4 hours on the same server, within 8 hours on new
  hardware from the off site copy. During that time labs keep working offline (GO-LIVE section 6).
- **RPO** (recovery point objective, the data loss limit): at most 15 minutes of server data for a database failure (WAL
  archive), at most 24 hours for loss of the whole office if the latest off site WAL did not arrive. Operations still in
  a device outbox are not lost; they are pushed again after the restore and the idempotency key keeps them single.
- If a drill measures worse numbers, the founder is told and the targets or the setup change.

## 4. Restore drill

Run before go live, every quarter, and after any change to the backup setup. Use a separate machine or virtual machine,
never the production database. Synthetic or production backup data stays on that isolated machine and is wiped after.

1. Record the start time. Pick the restore point: the latest nightly backup plus WAL up to a chosen time.
2. Fetch the backup from the **off site** copy (not the local one), to prove the off site copy works.
3. Decrypt it with the key held per the credentials decision. If the key cannot be found, the drill fails.
4. Restore the base backup into an empty PostgreSQL 17 data directory and replay WAL up to the restore point
   (`recovery_target_time`).
5. Start PostgreSQL and run the database checks: it accepts connections, migrations table matches the expected latest
   migration, row counts of a few key tables match the counts recorded at backup time.
6. Restore the object store mirror into an empty bucket. Compare object counts and the sha256 of a sample of objects
   against `x-amz-meta-sha256`.
7. Point a copy of the API at the restored database and bucket (on the isolated machine, not on the public name), run
   the smoke test list of [CUTOVER-ROLLBACK.md](CUTOVER-ROLLBACK.md), and open a few synthetic reports and files.
8. Record the end time. RTO measured = end minus start. RPO measured = backup point versus the last write before it.
9. Write the result in the operations log: date, who ran it, restore point, RTO and RPO measured, problems found.
10. Wipe the isolated machine.

A failed drill blocks go live. A missed quarterly drill is reported to the founder.

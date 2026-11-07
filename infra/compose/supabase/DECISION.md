# Supabase compose decisions (C1)

## T-09 - WAL archiving / backup tool (02-TRD s9.1)

Decision: pgBackRest 2.60.0 (PROVISIONAL until the build spike passes on CI; fallback WAL-G per TRD s9.1).

Status of the done-when items (2026-11-07):
- Committed: derived image `infra/images/postgres-pgbackrest/Dockerfile` (builder stage, digest-pinned base,
  sha256-checked release tarball), `infra/database/pgbackrest/pgbackrest.conf.j2` (repo1 posix + repo2 sftp,
  `aes-256-cbc` on both), `archive_command = 'pgbackrest --stanza=lims archive-push %p'`, role `pgbackrest`
  (timers: full weekly, incr daily, check every 15 min, verify weekly, metrics every minute), `pgbackrest_metrics.sh`.
- NOT yet run (needs the image build + data-1/dr-1): `pgbackrest check` on both repos, first full + incr backup,
  `info`/`repo-ls --output=json` field names against real output. Record results here when run.

Multi-repo failure behaviour (03-APP-FLOW s3.3). Source so far: the EDB-hosted pgBackRest guide (secondary,
read 2026-11-06); the re-check against pgbackrest.org for 2.60 is still OPEN (no network from the writer session):
- `archive-push` tries every reachable repo; when one repo (repo1 or repo2) fails it still returns an error to
  PostgreSQL, so PostgreSQL keeps the segment in `pg_wal` and retries.
- With `archive-async=y` the async process keeps delivering WAL to the working repo, so a repo1 failure does
  not stop repo2 (off-site) from staying current; `pg_wal` grows on data-1 -> `WalArchiveFailing` + `DiskFillForecast`.
- Spool above `archive-push-queue-max` (20GiB): queued WAL is dropped and success is reported -> PITR gap
  until the next full backup (runbook forces one).

WAL volume per day (06 R8, founder item F-10): NOT measured yet. Planning estimate from TRD s9.4 worst case:
24 GiB/day before compression (1,536 segments x 16 MiB); the size after `compress-type=zst` is the M2
measurement. Replace this line with the measured value, and apply R8 if repo2 exceeds 60 % of its volume.

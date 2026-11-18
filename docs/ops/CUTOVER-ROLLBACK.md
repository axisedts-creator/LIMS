# Cutover and rollback: cloud to the own server (T0B-GOLIVE-1, LD-322)

Companion to [GO-LIVE-OWN-SERVER.md](GO-LIVE-OWN-SERVER.md) and [BACKUP-RESTORE.md](BACKUP-RESTORE.md). Moves the
system from the Supabase test project and the cloud API (Render) and web (Vercel) to the founder own server. The cloud
copy stays the fallback until the own server is proven for at least 14 days. No secrets or real addresses here; hosts
are placeholders (`lims.example.com`, `cloud.example.com`).

## 1. Before the cutover

- [ ] The own server passes the checklist of GO-LIVE section 2, the restore drill and the outage drill.
- [ ] The founder decisions of GO-LIVE section 7 are made, including the legal review and the accountant confirmation.
- [ ] The same release is deployed on the cloud and on the own server; all migrations applied on both.
- [ ] A full rehearsal of this document was done once with a copy of the data, and its timings recorded.
- [ ] DNS time to live of the public name lowered to 300 seconds at least 24 hours before.
- [ ] Labs told the date and the freeze window at least 3 days before.

## 2. Freeze window

A planned window at low load (for example Sunday 05:00 to 09:00 NPT). During the freeze window:

- The cloud API is set to read only maintenance (writes refused with a clear message); browsers fall back to offline
  mode and keep operations in their outbox, so labs keep working.
- No deploys, no master data imports, no user changes.
- Workers on the cloud are stopped after the job queue is empty, so no job runs twice.

## 3. Cutover

1. Start the freeze window. Confirm the cloud job queue is empty and the cloud API refuses writes.
2. **Database dump**: take a final `pg_dump` (custom format) of the Supabase test project database, and record row counts
   of key tables.
3. **Restore**: `pg_restore` it into the own server PostgreSQL 17, then run the migrations check and compare the row
   counts. Any difference stops the cutover (go to rollback).
4. **Storage objects through the S3 adapter**: mirror the Supabase bucket to the own server bucket with an S3 copy tool
   (for example `mc mirror`, STORAGE.md), then compare object counts and a sample of sha256 values.
5. **Secrets**: the founder (or the named credentials holder) types the production secrets directly into the own server
   environment: database URL, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` and the rest of the
   names in `.env.example`. New keys are generated for the own server; cloud keys are not copied. The lead never sees
   them; they are never pasted into chat, tickets, commits or logs.
6. Start the API, the worker and the proxy on the own server. Check API health from outside through the VPN.
7. **DNS**: point the public name (`lims.example.com`) at the own server proxy. Keep the cloud reachable under its own
   name (`cloud.example.com`) for rollback.
8. Run the smoke test list below against the own server.
9. End the freeze window: allow writes. Offline devices sync their outboxes to the own server; watch the sync backlog
   age and the conflict inbox until both are back to normal. Provisional numbers issued during the window are mapped to
   final numbers by the server.
10. Keep the cloud copy running in read only mode as the fallback for at least 14 days.

## 4. Smoke test

Run with a synthetic test patient in a test tenant, then with one real lab user under supervision:

1. Sign in with MFA; the right permissions are shown.
2. Register a synthetic patient and an order; bill it and record a receipt; the receipt number is gap free.
3. Print a label with the lab code; mark collection and accession.
4. Enter a result, verify it at the configured level, print the report; the report PDF opens.
5. Upload a file above 256 KiB and download it; the sha256 matches.
6. An instrument message (or the instrument simulator) arrives and is matched.
7. An offline device with queued operations syncs; provisional numbers become final; no duplicates.
8. The monitoring dashboard shows every alert green; the external check sees the public name.
9. A nightly backup and the WAL archive run on the own server (check the next morning; backup age alert is green).

Any failure in steps 1 to 7 means rollback.

## 5. Rollback

Rollback returns to the cloud copy (the cloud API and the Supabase test project). Decide within the first 2 hours after
writes are allowed; later, writes made on the own server must be carried back.

1. Start a new freeze: set the own server API to read only maintenance; devices keep working offline.
2. If writes were already made on the own server: dump them (`pg_dump` of the changed tables, or the full database) and
   restore them into the cloud database, and mirror new storage objects back to the cloud bucket. Compare counts.
3. Point DNS for the public name back to the cloud (low time to live makes this fast).
4. Allow writes on the cloud API; restart the cloud workers.
5. Offline devices sync to the cloud; the op_id idempotency key makes a second send of the same operation harmless.
6. Run the smoke test list against the cloud.
7. Write down what failed, fix it on the own server, rehearse again, and plan a new cutover date.

The cloud copy is retired only after 14 days without a rollback, a passed quarterly restore drill on the own server, and
the founder's approval. Retiring it deletes data and stays a founder decision.

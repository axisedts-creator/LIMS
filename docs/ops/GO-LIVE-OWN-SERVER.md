# Go live on the founder own server (T0B-GOLIVE-1, LD-322)

Runbook for moving production from the cloud test setup (Supabase test project, Render API, Vercel web) to the founder
own server in another office with continuous electricity (founder, 2026-11-17 09:20 NPT). Documents only: no
configuration, no secrets, no real addresses. Every host below is a placeholder (`*.example.com`, `*.invalid`, the
RFC 5737 range 203.0.113.0/24). The cloud copy stays the fallback until the own server has passed the restore drill
and the outage drill.

Companion documents: [BACKUP-RESTORE.md](BACKUP-RESTORE.md), [CUTOVER-ROLLBACK.md](CUTOVER-ROLLBACK.md),
[STORAGE.md](STORAGE.md) (the provider neutral S3 adapter of T0B-STORAGE-1).

## 1. Topology

The server lives in a different office from the labs. Every lab and collection point reaches it over the internet or
over a private link. The design source is `C:/LIMS-state/offline-design-20261117.md`: the link from a lab to the server
is the part that fails, so the browser offline layer on each PC is the first line of resilience.

### Recommended layout

```
 Lab PCs / collection points                   Server office (continuous power)
 ---------------------------                   --------------------------------
 browser (web app, offline outbox)  --HTTPS-->  firewall (only 443 open to the internet)
                                                 |
 staff and admin laptops  --VPN / private tunnel-->  reverse proxy with TLS (one public name, lims.example.com)
                                                 |        |
                                                 |        +--> API service (Node, the same build as the cloud API)
                                                 |        +--> worker service (graphile-worker jobs)
                                                 |
                                                 +--> PostgreSQL 17 (private network only, never published)
                                                 +--> S3 compatible object store, for example MinIO (private only)
                                                 +--> monitoring agent and backup jobs
```

- **Server**: one physical machine (or two, see section 2) running the API, the worker, PostgreSQL and the object
  store as separate services under a service manager that restarts them on failure and on boot.
- **Database**: PostgreSQL 17 listening only on the private interface (for example 10.0.0.10). Never reachable from the
  internet. Continuous WAL archiving to the backup target (see BACKUP-RESTORE.md).
- **Object storage**: an S3 compatible store on the private interface with one private bucket. The API speaks plain S3
  through the T0B-STORAGE-1 adapter, so only `STORAGE_ENDPOINT` and the keys change (STORAGE.md).
- **Reverse proxy with TLS**: the only service published to the internet, on port 443 (80 only redirects to 443).
  TLS certificates from a public certificate authority with automatic renewal. HSTS on. It forwards to the API and
  serves the web build.
- **Private tunnel or VPN**: staff who administer the server and any lab that can afford it reach the server over a VPN
  or private tunnel (for example WireGuard). Admin access (SSH, database console, object store console, monitoring
  dashboards) is only over the VPN, with keys, never passwords.
- **No patient data exposed directly to the internet**: the database, the object store and the bucket are private.
  Files reach a browser only through the API (or, after P-2, short lived signed URLs through the proxy).
- **No open management ports**: SSH, 5432, the MinIO console, the monitoring UI and any hardware management interface
  (IPMI, iDRAC, iLO) are closed on the public side. A port scan from outside the office must show only 443 (and 80).

### What the lab PCs need

- A current Chromium based browser or Firefox, kept updated, with the web app installed as a PWA so the offline layer
  (T0D-OFFLINE-1 to T0D-OFFLINE-4) can keep its encrypted local store.
- A registered device entry (device registry of T0B-SYNC-1) and a user who has signed in online on that device in the
  last 14 days (offline sign in rule).
- An internet connection; a second connection (mobile data dongle) is recommended where the lab can afford it.
- The label and report printers already used, plus a small UPS per reception PC so a power cut does not lose work in
  progress (the local outbox survives a reboot; an unsaved form may not).
- Correct clock (automatic time sync on). Skew above 5 minutes is flagged; above 24 hours the operation is rejected.
- Nothing else: no database client, no VPN for ordinary front desk staff unless the founder chooses a private link.

## 2. Power is not availability

Continuous power is not continuous availability. The office has power; the server can still be down for a disk, a
router, an ISP, a thief, a fire or a bad patch. Checklist, all to be ticked before go live:

- [ ] **Disk failure**: RAID 1 (mirrored disks) or RAID 10 for the database and object store, plus backups. RAID is not a
      backup; it only survives one disk. Disk health (SMART) is monitored and a failed disk is an alert.
- [ ] **UPS**: an online UPS sized for the server, router and switch for at least 30 minutes, with a USB or network link
      so the server shuts down cleanly when the battery runs low.
- [ ] **Automatic restart after power return**: BIOS set to power on after AC returns; all services start on boot in the
      right order (database, object store, API, worker, proxy); a boot check confirms API health.
- [ ] **ISP and router redundancy**: two ISPs from different providers (fibre plus a second fibre or a 4G/5G router),
      a router that fails over automatically, and a spare router configured and stored on site.
- [ ] **Theft and fire**: the server in a locked rack or room; full disk encryption; an encrypted off site copy in a
      second location and provider (BACKUP-RESTORE.md), so losing the whole office loses at most the RPO.
- [ ] **Remote hands**: a named person at the server office who can press a power button, swap a disk or a router and
      read a screen, with written instructions and a phone list kept outside the repository.
- [ ] **Patching**: operating system security patches weekly, PostgreSQL minor releases within a month, the app through
      the normal release process. Every patch on the staging copy first.
- [ ] **Maintenance window policy**: a fixed weekly maintenance window at low load (for example Sunday 05:00 to 07:00
      NPT), announced to labs at least 48 hours before. Labs keep working offline during the window; the sync backlog
      is drained after it.
- [ ] **Spare parts**: one spare disk of the same size and a spare power supply if the server allows it.

## 3. Backups

Full detail in [BACKUP-RESTORE.md](BACKUP-RESTORE.md): nightly full database backup, continuous log archive, object
storage replication, encrypted off site copies in a second location and provider, a retention schedule and a quarterly
restore drill. A restore that was never tested counts as no backup.

## 4. Monitoring

An agent on the server collects metrics; an external check from outside the office watches the public endpoint. Alerts
go to the on call person first, then to the backup person after 15 minutes without acknowledgement.

| Alert | Warning | Critical |
|---|---|---|
| disk use (database, object store, backup volume) | above 75 % | above 90 % or any failed RAID member |
| memory | above 85 % for 10 minutes | swap in use or out of memory kill |
| database health | replication or WAL archive lag above 5 minutes | database not accepting connections |
| API health (`/v1/core/health/ready` from outside) | slow above 2 seconds | 2 failed checks in a row |
| certificate expiry | under 21 days | under 7 days |
| backup age | last good nightly backup older than 26 hours | older than 50 hours, or WAL archive older than 15 minutes |
| sync backlog age (oldest unapplied operation) | above 1 hour | above 6 hours |
| conflict inbox size (open sync conflicts) | above 20 | above 100, or any conflict older than 2 days |
| UPS on battery | on battery | battery below 30 % |
| ISP failover | secondary link active | both links down (seen by the external check) |

### Who is called and how

- **On call**: one named technical person per week (rota kept outside the repository). Alerts by push notification and
  SMS from the monitoring service; critical alerts also by phone call.
- **Backup person**: called when the on call person does not acknowledge in 15 minutes.
- **Lab managers**: told by a message from the on call person when the API is down for more than 15 minutes, so staff
  switch to the offline procedure in section 6.
- **Founder**: told of any outage above 2 hours, any data loss, any failed backup or restore drill.

### Status page or outside check

An external uptime service (outside the office and outside the server provider) checks the public health URL every
minute and serves a simple status page (for example `https://status.example.com`). Labs open it when the app looks
offline, to tell a local internet problem from a server outage.

## 5. Cutover and rollback

Step by step move from the cloud to the own server, the freeze window, the smoke test list and the rollback to the cloud
copy: [CUTOVER-ROLLBACK.md](CUTOVER-ROLLBACK.md).

## 6. Offline link

The offline layer is built by T0B-SYNC-1 to T0B-SYNC-5 (server) and T0D-OFFLINE-1 to T0D-OFFLINE-4 (browser), designed in
the offline design note (LD-322). How it behaves during a long server outage:

- The browser keeps working on cached reads (test catalog, price list, doctors, centres, the signed in user
  permissions, worklists of the day, verification policy, print profile) and writes every action as an operation into
  the encrypted local outbox (AES-GCM, PIN derived key, wipe after 10 wrong PINs).
- Registration, billing receipts, collection, accession, result entry, verification and printing work offline. Bill,
  invoice and receipt numbers are PROVISIONAL (`OFF-<device>-<n>`, watermark issued offline, pending sync); lab codes and
  patient ids come from the device block reserved while online.
- Online only actions are refused with a visible reason: SMS and WhatsApp sending, online payments, user and role
  changes, imports, approvals that need MFA step up (unless the tenant policy allows a locally signed in pathologist,
  default off).
- When the server returns, each device sends its outbox in batches of at most 50 operations and 1 MB, one batch in
  flight per device, with exponential backoff and full jitter capped at 5 minutes and honouring `retry_after`. The
  server applies each operation on its own, assigns final numbers, returns the provisional to final mapping and puts
  stale edits in the conflict inbox.
- Local data stays at most 14 days (retention window); after that the device must sync and sign in online.

### What staff do

1. Keep working. The app shows an offline banner and the count of pending operations.
2. Do not clear the browser data, do not switch to another PC for the same patient, do not reinstall the browser.
3. Hand patients the provisional bill or receipt; tell them the final number follows by SMS or on the reprint.
4. Note in the paper log any action the app refuses offline (online payments, SMS), to redo once online.
5. When the banner shows online again, leave the PC on until the pending count reaches zero.
6. The lab manager opens the conflict inbox and resolves every conflict the same day.
7. If the pending count does not fall within 30 minutes of being online, call the on call person.

### Outage drill

Run before go live and after every change to the sync layer (the acceptance drill of the offline design):

1. Pick one lab PC and one test tenant with synthetic data only.
2. Disconnect the PC from the network for a full working day (or block the server name in the firewall).
3. On that PC: register patients, bill and take receipts, mark collection, accession, enter results, verify, print.
4. On a second PC that stays online: edit one of the same patients, so a conflict is created on purpose.
5. Reconnect. Watch the pending count fall to zero.
6. Check: every operation landed once, no duplicate patient or receipt, provisional numbers are mapped to final gap
   free numbers, the conflict is in the conflict inbox, the audit trail shows both device time and server time, any
   verification that fails the policy at sync recalls the printed report and alerts the lab manager.
7. Write the result (date, counts, problems) in the operations log; a failed drill blocks go live.

## 7. Founder decisions

Everything in this section stays with the founder. The lead does not decide or spend on any of them; the lead only
prepares the options. Each has options and a recommended default.

### Hardware spend
- Options: (a) one tower server with RAID 1 and a UPS; (b) two servers, primary plus warm standby with streaming
  replication; (c) a rented dedicated server in a data centre instead of the office.
- Recommended default: (a) now, with the off site copy, and (b) once more than a few labs depend on it.

### ISP spend
- Options: (a) one ISP; (b) two ISPs from different providers with automatic failover; (c) one ISP plus a 4G/5G
  backup router.
- Recommended default: (b) for the server office; (c) for the larger labs.

### Provider choices
- Options for the off site object store, the uptime monitor and the VPN: a local Nepali provider, an international S3
  compatible provider, or a second founder owned site.
- Recommended default: an S3 compatible provider so the T0B-STORAGE-1 adapter needs no change; the founder chooses the
  vendor.

### Backup location and provider
- Options: (a) a second founder office with its own disk; (b) a cloud S3 compatible bucket at a different provider; (c) both.
- Recommended default: (c), encrypted before upload, so one fire or one provider failure never loses every copy.

### Who holds the credentials
- Options: (a) founder only; (b) founder plus one named technical person; (c) a password manager with two holders and
  a sealed break glass copy kept off site.
- Recommended default: (c). Credentials are never written in the repository, a ticket, a chat or a log.

### Legal review of patient data hosting and retention rules in Nepal
- Options: (a) review by a Nepali lawyer before go live; (b) go live on synthetic data only until the review is done.
- Recommended default: (a). Covers where patient data may be hosted, whether an off site copy abroad is allowed,
  consent, and the retention period for reports and records (also sets the backup retention schedule).

### Which devices may work offline
- Options: (a) every registered lab PC; (b) only reception and lab PCs named by each lab manager; (c) none until the
  outage drill passes.
- Recommended default: (b), after (c) is satisfied. Personal phones never hold offline patient data.

### Offline rules (from the offline design)
- Provisional then final bill and receipt numbers: the accountant must confirm against tax invoice rules before go live.
  Options: provisional numbers (recommended default) or reserved number blocks.
- Offline retention days: default 14. PIN rules and wipe after 10 failures: default as designed. Offline approval by a
  pathologist: default off. Block sizes: default 200 lab codes, 100 patient ids.

## 8. Unknowns and open questions

Stated plainly; none is decided here:

- The server hardware, its location details, the ISPs and the VPN product are not yet known.
- The legal position on hosting patient data and off site copies in or outside Nepal is not yet known.
- The accountant has not yet confirmed provisional bill numbers.
- The real RTO and RPO are targets until the first restore drill measures them.
- The offline layer (T0B-SYNC-1 to T0B-SYNC-5, T0D-OFFLINE-1 to T0D-OFFLINE-4) is queued, not yet on main; section 6
  describes the design, and the outage drill proves it.
- Direct signed URL file transfer (P-2, CR-C0-FILES-1) is not wired yet; until then files move through the API.

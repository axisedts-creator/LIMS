# Offline sync runbook (T0B-SYNC-5, LD-322)

Scope: the server side of offline work (T0B-SYNC-1 to T0B-SYNC-5): device registry, push of batches, conflict inbox, sign offs and prints made
offline, retention and metrics. Design source: `C:/LIMS-state/offline-design-20261117.md`. Synthetic data only in every example.

Permissions: `sync.use` (a device pushes and pulls), `sync.device.manage` (list, revoke, wipe devices), `sync.conflict.resolve` (conflict inbox).

## Reading the conflict inbox

A conflict is an offline operation that met a server change it cannot merge on its own (for example an order registered on two devices,
or an entity changed on the server after the device read it: `sync.entity_changed`). The operation is stored with status `conflict`
and one row in the inbox, status `open`.

1. List: `listSyncConflicts` (GET /v1/core/sync/conflicts), filtered by status `open`. Needs `sync.conflict.resolve`.
2. Open one: `getSyncConflict` (GET /v1/core/sync/conflicts/{conflict_id}) shows the local payload (what the device sent) and the
   server payload (what the server holds).
3. Resolve: `resolveSyncConflict` (POST /v1/core/sync/conflicts/{conflict_id}/resolve) with one of three resolutions:
   - `keep_server`: the server state stays, the device work is dropped;
   - `apply_local`: the device payload is applied now through the owning module;
   - `merge`: a merged payload (written by the resolver) is applied.
   A reason is required (1 to 1000 characters) and is kept with the resolution. A conflict is resolved once; a second attempt answers
   `common.immutable_record`.
4. The inbox size is the gauge `lims_core_sync_conflicts_open`; see the alert table below.

## Revoke or wipe a device

1. Find the device: `listSyncDevices` (GET /v1/core/sync/devices). Needs `sync.device.manage`.
2. Revoke: `revokeSyncDevice` (POST /v1/core/sync/devices/{device_id}/revoke). Every later push or pull of that device is refused with
   `sync.device_revoked`; nothing it still holds is applied. Use when a device is lost, stolen or leaves the lab.
3. Remote wipe: `requestSyncDeviceWipe` (POST /v1/core/sync/devices/{device_id}/wipe). The device is told `sync.wipe_required` at its next
   contact, erases its encrypted local store and confirms with `ackDeviceWipe` (POST /v1/core/sync/devices/{device_id}/wipe-ack).
   A wipe that is never acknowledged means the device has not come online since: keep it revoked.
4. Unsent work on a wiped device is lost by design. Ask the user what was done offline and enter it again online.

## What a recall means

A report printed offline relies on the sign offs made on the same device. At sync the server checks every offline `result.verify` again
against the verification policy. When one fails (`sync.verification_policy_failed`), every report printed offline on that sign off is
moved to `recall_required`: the paper report already handed out must be called back and replaced after a proper verification.

- Who is alerted: the lab manager (an alert row of kind verification_policy_failed for the tenant, ids and codes only).
- Where to see it: the gauge `lims_core_sync_print_recalls` (count of print markers in state `recall_required`) and the alerts list of the lab.
- A result locked on the server before the device synced (`sync.result_locked`) is refused and also alerted to the lab manager.

## Outage drill

Follow section 11 of `offline-design-20261117.md` on a test tenant with synthetic patients, at least twice a year and after every release
that touches sync:

1. Disconnect the lab network from the server (unplug the uplink; keep electricity on).
2. On two devices: register two patients and orders (one order registered on both devices), bill and record a receipt, collect the
   specimens, accession them, enter results, verify them, print a report.
3. Note the provisional numbers printed (they start with `OFF-`) and the device clocks.
4. Reconnect. Let the devices push (one batch in flight per device).
5. Check afterwards:
   - no duplicates: each order, receipt and specimen exists once;
   - no lost operations: every operation of both devices has a ledger row (accepted, duplicate, rejected or conflict);
   - numbers are finalised: every provisional `OFF-` number maps to a final, gap free number;
   - conflicts are listed: the order registered on both devices is in the conflict inbox;
   - device and server times: the skew recorded for each device is inside the 24 hour limit (else `sync.clock_skew_too_large`).
6. Resolve the drill conflicts with a reason, then record the result of the drill.

## After a long outage

Work through this list once the devices have reconnected:

- [ ] Backlog: `lims_core_sync_device_backlog_age_seconds` falls to 0 for every active device; a device that stays high has not pushed yet.
- [ ] Rate limited devices: a device refused with `common.rate_limited` waits for `retry_after` and then retries; many 429 answers in a
      row are normal for the first minutes and stop by themselves (batches of at most 50 operations and 1 MB, backoff with full jitter).
- [ ] Refused batches: `sync.batch_too_large` means a device built a batch above 50 operations or 1 MB: update the app.
- [ ] Conflict inbox: list and resolve every open conflict (`lims_core_sync_conflicts_open`).
- [ ] Provisional numbers: every receipt or bill printed with a provisional `OFF-` number has its final number (number mapping of the push
      answer); give customers the final number when they ask.
- [ ] Recalls: call back every report in `recall_required` (`lims_core_sync_print_recalls`).
- [ ] Refused operations with `sync.op_id_reused` or `sync.base_version_stale`: check them with the device user.

## Alert thresholds

Exposed through the existing metrics path (`/metrics` of the api and of the worker; registry in core/observability/metrics.ts).

| Metric | Alert when |
|---|---|
| `lims_core_sync_operations_total{status}` (accepted, duplicate, rejected, conflict) | rejected above 5 % of all operations over 15 minutes |
| `lims_core_sync_batches_total{outcome}` | too_large or rate_limited outcomes above 20 per tenant in 10 minutes |
| `lims_core_sync_device_backlog_age_seconds{tenant_id,device_id}` | above 86400 seconds (24 hours) for an active device |
| `lims_core_sync_conflicts_open{tenant_id}` | above 20 open conflicts, or any open conflict older than 2 days |
| `lims_core_sync_print_recalls{tenant_id}` | above 0 (every recall needs a person) |
| `lims_core_sync_oldest_unsynced_age_seconds{tenant_id}` | above 86400 seconds (backlog of the tenant) |
| `lims_core_retention_purged_total{table}` | 0 rows for 7 days while the ledger grows, or `lims_core_retention_purge_capped_total` moving on 3 runs in a row |

## Retention

The worker task `core.sync_retention` (daily, 03:30 Asia/Kathmandu, one job per tenant) removes, in small batches with row locks only:

- resolved conflicts resolved more than 180 days ago (default retention 180 days);
- operations received more than 180 days ago that have no conflict row left and no pending or recall_required print marker,
  with their sign off outcomes, alerts and confirmed print marker.

It never removes an open conflict (or its operation), a pending print marker (or its operation), a recall_required marker, or audit
events: the audit log only grows. Each run stops after 200 batches of 500 rows; the rest goes on the next run
(`lims_core_retention_purge_capped_total`). The task `core.sync_metrics` (every 5 minutes, per tenant) refreshes the sync gauges.
Open point: the retention days are the default for every tenant until a tenant setting exists.

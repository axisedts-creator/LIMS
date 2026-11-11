# C6-T24 impl (writer)
Files: worker `consumers/lab.critical_value.detected.v1.ts` (new) + subscription in `jobs/reporting/index.ts`; api `repository/delivery.repo.ts` (+findLabReportOfOrder, listCriticalAlertDeliveries, findReportRefs); `handlers/reports-read.handlers.ts` (+listCriticalAlerts R18).
Consumer: referrer via `startDelivery` (consent/channel/contact -> queued or suppressed row); staff via `insertDelivery` direct, always suppressed `no_contact` (no C2 call). lab_name/lab_phone = IdentityPort branding.displayName / phones[0] (ruling); malformed payload = no-op, tenant mismatch = throw.
[CONV] lab_phone omitted from params when branding has no phone (no CR on no-phone behaviour; send then fails param check, never invents a number).
[CONV] R18 groups the whole window (<= 7 d) in memory, newest alerted_at first, tie by critical_event_id; cursor = base64url {k: alerted_at, i: critical_event_id}; unknown query key -> 400.
[CONV] staff rows with is_active = false skipped.
Tests: consumer 26/26, R18 32/32, worker reporting 523/523, api reporting 1638/1639 — the 1 failure is pre-existing inline SQL in service/portal.service.ts (repository.static), not touched here.
Open: real PG/RLS + EXPLAIN on the index not run; staff membership-active check (ctx.core.membership) not done.

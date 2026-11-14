APPROVE

Reviewed `git diff 268fe206..HEAD` (HC-T07) against 02-TRD §8.2 rows 4-5 / §3.2, 03-IC §3.7/§3.8, 01-PRD US-11-1/2, US-14-1/2, 03-APP-FLOW V3, 05-SCHEMA.

Checked, no defects:
- Names verbatim: event types, export names (`onSpecimenStatusChanged`, `onSpecimenRejected` per TRD §3.2), kind `recollection`, flag `recollection_required`, transition cause `consumer` (05-SCHEMA cause CHECK), `common.validation_failed` / `common.version_conflict`.
- US-14-1: upsert per visit of order within 30 days [CONV], applies only if `aggregate.seq` > `last_seq`; route version bumped once per touched route (updateRow bumps version on empty patch). Replacement specimen -> new row with `replaces_specimen_id`, old row untouched.
- US-14-2: no visit -> return, nothing stored.
- US-11-1: recollection visit copies address/geo from parent, unassigned, no window/route, transition null->unassigned, flag on new visit; idempotent per specimen via advisory xact lock + existence check + partial unique index `visits__tenant_id_recollection__p_uq`. Foreign-order `home_visit_id` never used as parent.
- US-11-2: `recollection_required !== true` -> no-op.
- Tenant isolation: event.tenant_id != ctx.tenantId no-op; every query filters tenant_id and runs under RLS in ctx.tx. No new tables/policies in this task.
- No logs, no barcode, no PHI; no LabPort call; no secrets (harness generates random passwords). Paths owned (worker homecollection consumers/tests, tests/homecollection, own notes).
- Tests cover every done_when item (stale/equal seq, idempotency per specimen incl. races, no-visit order, window, tenant isolation, log hygiene).

Independent check run by reviewer: `tsc --noEmit -p services/worker` -> no errors in homecollection files.

Not blocking / for the lead:
- Live suite NOT executed by writer or reviewer (Docker). Run `.orchestra\notes\HC-T07-verify.cmd` before merge.
- No homecollection worker manifest (`jobs/homecollection/index.ts` subscriptions) exists yet, so neither these handlers nor HC-T05's are registered; outside HC-T07's file list, needs its own task.
- A few assertions are vacuous (`r.threw === undefined || r.threw`, test line ~425 `|| true`); state assertions after them still carry the check.

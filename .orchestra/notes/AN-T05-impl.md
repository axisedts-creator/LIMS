# AN-T05 impl (writer)
- New `services/worker/src/jobs/analytics/consumers/index.ts` (12 handlers: table-driven `SPECS` + `orderCreated`/`orderCancelled`); reuses AN-T04 `markDirty`, `upsertOrderCreated`, `recordOrderCancelled`.
- Wiring edit in `jobs/analytics/index.ts` (AN-T01 file, 2 lines): subscriptions use `consumers[type]`; stub kept only as fallback.
- [CONV] bd() evaluated in SQL (`SELECT (($1::timestamptz) AT TIME ZONE 'Asia/Kathmandu')::date::text`), one extra round-trip per event; anchors need explicit offset (bare local time rejected).
- [CONV] envelope.tenant_id != ctx.tenantId or no tenant => throw before any write; enqueue (`now()+60 s`, max_attempts 5, job_key `analytics.refresh_tenant:<tenant>`) is last, failure rejects.
- [CONV] order.cancelled re-SELECTs `registered_on` after UPDATE/placeholder; NULL => only report_backlog marked. delivery uses `delivery_created_at` when non-null (D-48) else `changed_at`.
- Open: live DB test (`consumers.live.test.ts`) not run, no DB here. tsc errors elsewhere in worker (contracts/ports, catalog, reporting) pre-exist; none in analytics.

APPROVE

# AN-T05 review (reviewer)
- Scope `df4e07a7..HEAD`: `jobs/analytics/consumers/index.ts` (new), 2-line wiring in `jobs/analytics/index.ts`, tests under `jobs/analytics/__tests__/`, notes. All C8-owned paths.
- 12 event types + family/date mapping match TRD §8.2 table exactly (incl. specimen to_status sets, report_backlog @ 1970-01-01 sentinel, health_changed @ bd(now), D-48 delivery_created_at else changed_at).
- Payload field names checked against `contracts/events/*.schema.json`: every anchor (issued_at, cancelled_at, changed_at, verified_at, approved_at, amended_at, detected_at, released_at, registered_at, delivery_created_at) and order_index fields exist verbatim. D-1/D-2 optional fields never read.
- order_index: reuses AN-T04 repo (upsert `... DO UPDATE ... WHERE registered_on IS NULL`, placeholder, created_by = ctx.actor.id, expires_at +400 d); UUIDs asserted in repo. order.cancelled marks order families only when registered_on known.
- markDirty + single `app.enqueue_job('analytics.refresh_tenant', {tenant_id}, 'analytics.refresh_tenant:'||t, now()+60 s, 5)` verbatim. Tenant = ctx.tenantId; envelope mismatch rejects before writes. No logging, no PHI, no secrets; no metric values read.
- Ran `vitest run` (consumers, consumers.live, manifest): 256 passed, 3 skipped (live DB tests, no DB here — NOT executed).
- Note (not a defect): bd() runs as a separate SELECT, not the same statement as the write; expression identical to spec, result equal.

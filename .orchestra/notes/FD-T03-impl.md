# FD-T03 impl
- Files: services/api/src/modules/frontdesk/repository/{shared,patients,consents,orders,orderItems,discounts,discountApprovals,trf,flags,bookingLinks,settings,counters}.repo.ts; services/api/package.json + pnpm-lock.yaml (devDependency pg 8.23.1, already in lockfile via graphile-worker).
- [CONV] Contract as tester assumed: fn(tx, tenantId, ...), raw rows, null/[] on miss; every SQL binds tenant_id = $1 and is schema-qualified (REQ-SEC-024, search_path '').
- [CONV] insertRow: per-repo constant column allowlist (no identifiers from input); tenant_id always from the argument (row.tenant_id ignored); created_by/updated_by default to app.current_actor_id() when the row omits them; jsonb `discounts` JSON-encoded.
- [CONV] Counters: single INSERT ... ON CONFLICT DO UPDATE last_value+1 (row lock serialises; gaps on rollback allowed, 03-IC §9.3).
- Search: LIKE on name_search with %,_,\ escaped, NFC/lowercase/space-collapsed query, anonymised rows excluded, LIMIT bound.
- Ran: tests/frontdesk/FD-T03.pg.sh (docker PG17) = 83/83 pass. Unit suite: 14 failures, all outside frontdesk (instruments ci-scripts/signing, reporting repository.static). tsc: 1 error in packages/shared-ts/bsdate (not frontdesk).
- Open: no update/state-transition repo functions yet (later tasks add them with version/If-Match); centre-scope probes need memberships (handler tests).

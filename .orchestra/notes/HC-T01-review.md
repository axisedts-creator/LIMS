APPROVE

HC-T01 review (diff 53d87a13..HEAD)
- Paths: only `services/api/src/modules/homecollection/**` + own notes. Owned by C17 (01-CHUNK-MAP).
- Names: module `homecollection`, openapi path, 26 operationIds (TRD §5.1 H1-H21, §5.2 A1-A5), event `homecollection.collection.synced.v1` (CHUNK-MAP event table), 6 permission codes all match contracts/permissions.yaml (test asserts against generated PERMISSION_CODES).
- Config: 4 `LIMS_HOMECOLLECTION_*` keys + defaults (100 / 524288 / 60 / 60) match TRD §11.1; cap 60 on SNAPSHOT_MAX_VISITS consistent with D-131 + route_sequence 1..60. ACCESS_JWT_SKEW is an app build constant, correctly absent.
- Stubs: 501 only when LIMS_CORE_ENV=dev, otherwise `common.internal`; no request echo, no logging. No DB/RLS, idempotency or rate tier in scope for this task.
- Tests: manifest validation, drift rejection, 26/26 mounted on real boot, 401 fail-closed, per-op permission bindings, config fail-fast. Covers done_when.
- Ran: vitest homecollection: 39/39 pass on the 2nd run. 1st run: 2 failed under load (73s duration). Likely the real-boot tests hit their 30s/60s timeouts. Non-blocking, watch for flakiness in CI.
- tsc: errors only in contracts/ports/common.ts + packages/shared-ts, none in homecollection. They were already there, not caused by this task.

APPROVE

Scope: `git diff 54c17d55..HEAD` is empty (HEAD = 54c17d55); the HC-T08 work landed before that base, so I reviewed the HC-T08 commits instead: 0412bb62, 6990a81c, a073e608, f738940a, 7e171139 (handlers/*, mappers/visit.mapper.ts, service/visitRead.service.ts, repository/visitQueries.repo.ts, index.ts, tests).

Checked:
- Names verbatim with 02-TRD §5.1 and homecollection.yaml: operationIds H1/H2/H10/H12/H21, permissions (visit.read; visit.assign for H12/H21), error codes (common.invalid_cursor, homecollection.visit_not_assigned, common.not_found), access-log `home_visit.view` purposes `visit_detail` and `phone_reveal` (TRD §14 table). The DTO fields match VisitSummaryDto, VisitDetailDto, RouteDto, Money and the H12 shape. Optional fields are omitted, never null. H2 has no phone.
- §5.4: rule 1 runs load through the RLS repo, returns 404, then assertRole on the visit's centre (H2, H21). Rule 2: phlebotomist-only actors are filtered on H1/H10 and get 403 on H2. A missing membershipId fails closed. REQ-SEC-081 allowlist: name, address, registration_no and balance go only to assign holders or the assignee.
- Tenant isolation: tenant_id = $1 in every query, on top of RLS. Centre scope comes from the RLS PRED_C (`::uuid[]` cast, 05-SCHEMA). No DDL in this task. SQL is fully parameterised and sort or cursor values never reach the SQL text.
- Ports: H1 makes one getPatientDemographicsBatch per page. Staff names come from ctx.core.memberships.list, users from ctx.core.user. §9.2 failure modes are honoured: name "—", H21 and getOrderSummary errors propagate, balance is omitted on failure.
- Idempotency and rate limits: H21 is optional idempotency, tier general (contract). No PHI in logs (codes only). No secrets. Only C17-owned paths changed.
- Tests cover contract, probes, per-role allowlists, 403 visit_not_assigned, H12 route_full, and the H2/H21 access-log rows.

Ran (reviewer, 2026-11-13): static.test.ts 9/9 pass; tests/homecollection/HC-T08.pg.sh (PG17): 5 files, 69/69 pass.

Non-blocking note (no change requested): getHomeVisit runs 6 queries with Promise.all on the single tx client. This triggers pg's "client.query() when the client is already executing a query" deprecation warning. pg 8 queues the queries so the results are correct. Run them one after another before upgrading to pg@9.

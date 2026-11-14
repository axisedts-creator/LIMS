APPROVE

Reviewed `git diff 5e706b45..HEAD` (T-16, credit parties #67–#70) against 02-TRD §5 rows 67–70 + §5.1 CreditParty, 05-SCHEMA credit_parties, catalog.yaml CreditParty/Create/Update/list params, 01-PRD AC-12.1–12.4, 07-SECURITY REQ-SEC-081/082.
- Names verbatim: operationIds, path param `credit_party_id`, columns, kinds enum, `unset` enum, entity_type `credit_party`, error codes (`common.not_found`, `common.version_conflict`, `common.invalid_cursor`, `auth.unauthenticated`).
- AC-12.1: blank/whitespace party_code -> `CP{seq:5}` via code_counters upsert (row-locked). AC-12.4/REQ-SEC-081: pan/phone/email/address only when IdentityPort actor holds `catalog.price_list.manage`, on list/get/create/update; fails closed. AC-12.3: no limit/days/balance fields.
- Tenant: every statement carries `tenant_id = $1` bound; no schema/RLS change in this diff. REQ-SEC-082: bound params, escaped LIKE with ESCAPE '\\', q ≤20.
- Permissions/idempotency/rate tier left to core pipeline per x-permission/x-idempotency (consistent with T-15). No logging, no secrets, no PHI. Paths owned by C3.
- Ran T-16-verify: 3 files, 202/202 pass. tsc: no errors in T-16 files.
- Non-blocking: auto-code vs pre-existing explicit `CP00001` -> 409 remains the open CR (.orchestra/cr/T-15.md).

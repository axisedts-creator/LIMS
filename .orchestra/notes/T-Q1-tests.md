# T-Q1 tests (queues + counters Q1a-c, Q2a-c; centre probe C1 staff vs C2)
- File: services/api/src/modules/engagement/service/__tests__/queue.handlers.test.ts (fake tx with STAFF_C/tenant RLS model; handlers driven directly, as settings.handlers.test.ts).
- Run: `.orchestra\notes\T-Q1-verify.cmd` (= `pnpm --dir services/api exec vitest run src/modules/engagement/service/__tests__/queue.handlers.test.ts`).
- Covers: floors (operate vs manage), centre_id required on console lists, 201/200 shapes vs Queue/QueueCounter schemas, If-Match 428/409/200 + version bind, body validation 400, duplicate code -> 400 /code, no DELETE, 07 §6.4 probes (list/create/PUT at C2, tenant B ids -> 404 never 409).
- Seams ASSUMED (spec silent): assertRole(ctx,{permission,centreId}) before any query; foreign-centre list = forbidden OR empty; foreign create = forbidden OR not_found; PUT moving centre refused; handlers validate bodies themselves.
- Review round: list SELECTs must be `LIMIT 200` (maxItems 200); create at foreign/other-tenant centre -> forbidden|validation_failed only (no 404 on create). Ruling (record insert before throw) already applied.
- Fails now: all 8 operationIds are the T-01 placeholder (common.service_unavailable). No ACs listed for T-Q1 (US-EN-21 = T-Q2).

APPROVE

# T0D-05 review (reviewer) — diff 73683cd..218bc6f
- Spec checked: 02-TRD §6.6 steps 1–6, §6.2 stage 10; 03-APP-FLOW §3.1 K1–K5; 02-CV §4.5; 01-PRD AC-0D-4.1–4.6; 05-SCHEMA idempotency rows (D-213 UNIQUE NULLS NOT DISTINCT, policies).
- SQL verbatim with §6.6 (claim INSERT/ON CONFLICT, takeover UPDATE with `created_at <= now() - interval '60 seconds'`, release DELETE `state = 'in_progress'`); WHERE uses `IS NOT DISTINCT FROM` so NULL-tenant platform rows match (D-213). All values bound; no string interpolation of input.
- Error codes match 03 catalog: `common.idempotency_key_required` 400, `_reused` 422, `_in_progress` 409 + `retryAfterSeconds: 1`, `common.validation_failed`/`common.field_invalid`, `common.internal`. Key format `^[A-Za-z0-9_-]{1,64}$` = 02-CV §4.5.
- D-202: status < 400 stored in request tx (K2); ≥ 400 nothing stored; commitOnError deletes in-tx; release() after rollback in own tx, never rejects (K4 ages out stuck keys).
- Tenant/actor taken only from verified claims; platform ops require `scope: 'platform'` and no tenant_id. Logs carry only event/request_id/SQLSTATE — no body, key, PHI or secrets.
- Only owned paths (`services/api/src/core/**`, `.orchestra/notes/T0D-05-*`).
- Ran: `vitest run src/core/__tests__/idempotency.test.ts` → 89/89 pass; `tsc --noEmit` clean.
- Not verified (non-blocking, already noted by tester): real Postgres RLS/PgBouncer behaviour (schema tests 24/27), Fastify stage 6/10/11 wiring (pipeline task). `now` option unused — harmless.

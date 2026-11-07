# C6-T03 impl (writer)
- Files: `modules/reporting/repository/settings.repo.ts` (settings, staff_assignments, centre_contacts, referrer_preferences, cs_reasons+g_cs_reasons), `repository/records.repo.ts` (tenant by-id reads for the other 21 tables), `service/settings.service.ts`, `handlers/settings.handlers.ts`; `index.ts` wires the 8 handlers (others stay 501).
- [CONV] Static SQL only: partial updates use `col = COALESCE($n, col)`; lazy defaults = DDL defaults via `INSERT … ON CONFLICT (tenant_id) DO NOTHING` then re-select.
- [CONV] Staff removal = `is_active = false` (no DELETE grant); re-add = `ON CONFLICT … DO UPDATE SET is_active = true`; unchanged rows untouched. Signatory permission checks run before any write.
- [CONV] Handlers fail closed (`auth.unauthenticated`) until HandlerContext carries tenantId/actor/tx/core (T0D-02..10); If-Match parsed per 02-CV §4.2, ETag `"<version>"` on single-resource responses.
- [CONV] Masking: phone `****…<last4>`, email `<first char>***@<domain>`; raw address never returned or logged. FK/RLS SQLSTATEs pass through to core mapDbError.
- Open: `default_template_id_laboratory/_narrative` (OpenAPI, no 05-SCHEMA column) rejected as unknown_field until CR-C6-021 (`.orchestra/cr/C6-T03.md`) resolves. Review fix: If-Match version > 2147483647 -> 400 `common.validation_failed` (int32 column).
- Tests: reporting suite 284/284 pass; tsc clean. No live-DB/RLS run (no harness; lead item).

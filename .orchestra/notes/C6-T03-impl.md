# C6-T03 impl (writer)
- Files: `modules/reporting/repository/settings.repo.ts` (settings, staff_assignments, centre_contacts, referrer_preferences, cs_reasons+g_cs_reasons), `repository/records.repo.ts` (tenant by-id reads for the other 21 tables), `service/settings.service.ts`, `handlers/settings.handlers.ts`; `index.ts` wires the 8 handlers (others stay 501).
- [CONV] Static SQL only: partial updates use `col = COALESCE($n, col)`; lazy defaults = DDL defaults via `INSERT … ON CONFLICT (tenant_id) DO NOTHING` then re-select.
- [CONV] Staff removal = `is_active = false` (no DELETE grant); re-add = `ON CONFLICT … DO UPDATE SET is_active = true`; unchanged rows untouched. Signatory permission checks run before any write.
- [CONV] Handlers fail closed (`auth.unauthenticated`) until HandlerContext carries tenantId/actor/tx/core (T0D-02..10); If-Match parsed per 02-CV §4.2, ETag `"<version>"` on single-resource responses.
- [CONV] Masking: phone `****…<last4>`, email `<first char>***@<domain>`; raw address never returned or logged. FK/RLS SQLSTATEs pass through to core mapDbError.
- Open: `default_template_id_laboratory/_narrative` are in the OpenAPI settings schemas but have no 05-SCHEMA column — rejected as unknown_field and not returned; needs CR/clarification (C6-T18 area).
- Tests: verify set 282/282 pass; tsc clean; full api suite 1785/1786 — the 1 failure is a 5 s timeout in core errors.test.ts under parallel load (passes alone, 97/97). No live-DB/RLS run (pg_prove not run).

APPROVE

SP-9 review (diff 936e831..HEAD)
- Paths: db/meta/decisions/SP-9.md (brief file), tests/spikes/SP-9.decision.test.mjs (same location as SP-1..SP-8), .orchestra/notes/*. No other paths.
- Names verbatim: `app.current_tenant_id()`, `request.jwt.claims`, `set_config(..., true)` match 02-CONVENTIONS §5.8; `lims_api` matches 03; PgBouncer ≥1.21 / transaction mode / workers+migrations direct match 04 S8.
- done_when met: 1,000 interleaved txns, 2 server conns, tenants A/B, zero leaks with and without prepared statements, NULL outside txn, RLS (ENABLE+FORCE) cross-check, non-vacuous negative control; decision `max_prepared_statements = 200` recorded for C1 with "unnamed only" fallback.
- No secrets, synthetic uuids only, no PHI.
- Tests run: `node --test tests/spikes/*.test.mjs` 105/105 pass; SP-9 17/17.
- Non-blocking: evidence code block shows raw output for runs 1–2 only (runs 3, 4, control appear in the table only). Permanent CI interleaving test (AC-0D-2.3/R-8) still to be built under T0D-03.

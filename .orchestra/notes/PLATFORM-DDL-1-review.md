APPROVE

Reviewer notes (PLATFORM-DDL-1, diff fb203e22..7b06d7f0):
- 20261115191000: 19 `__platform` policies match C2 05-SCHEMA s5.3 rows 415-421 exactly (auth_events SELECT only, ird_annex_events no UPDATE, documents UPDATE via existing column grant); predicate verbatim; WITH CHECK on INSERT/UPDATE; none existed before (grep of db/); no GRANT needed (20261105001300:943-948 already grants). 1:1 in db/policies/identity.sql.
- 20261115192000: training_mode + immutability trigger = CR C2.T16 (1); tenant_contract_acceptances columns/CHECKs = CR C2.T22 (1); ENABLE+FORCE RLS; __tenant SELECT/INSERT use pred_t (spacing differs only, same parse tree), __platform SELECT; GRANT SELECT, INSERT only; tg_row_audit attached (audited). No DEFINER, no CREATE ROLE, leading `SET LOCAL ROLE lims_owner;` per ruling.
- tenant.service.ts: seedIrdAnnexes moved out of withTenantScope, after core.tenants insert, same tx -> covered by ird_annex_records__insert__platform (LD-223 option 3, no CR needed). Tests assert scope null, order, same tx, failure propagation.
- Ran independently: vitest 4 files 196/196 pass; check-registry ok; gen-isolation-probes --check ok (438); check-migrations only pre-existing partners.manifest_lines DELETE-grant error (not this task).
- Not verified: pgTAP not run (no DB); pnpm -s verify red on pre-existing typecheck per impl note, not re-run here.

# MET-T04 impl (writer)
- Files: NEW `db/migrations/20261114120000_instruments__add_getein_metis_driver.sql` (CR-C7-020: SET LOCAL ROLE lims_owner; then one INSERT, 14 H80E columns, generic, 0.1.0, caps host_query/qc true; no UPDATE); `apps/bridge-agent/testdata/sessions/metis-{api-down,oru-patient,q03-id-mismatch}.session.json`; `service/hostQuery.service.ts` (lead AUTO 12:38, LD-163).
- registry.ts, options schema (§8), CI registry check already in place from MET-T01..T03; no change.
- [CONV] hostQuery.service: parseQuery accepts 0 barcodes (<=50 and 1..40 checks kept); answerAll returns [] with no LabPort/CatalogPort call; driver.buildHostQueryReply gets answers []; step-2 gates untouched (non-verified driver stays inert).
- [CONV] Session files: PID.5 emptied (synthetic scan, ci-scripts "REAL repo"); metis-oru-patient raw_sha256 recomputed.
- Run: registry 9/9 + e2e 7/7 (26 tests incl. both files), hostQuery.service.test.ts 39/39, __tests__/ci green.
- Not verified: fresh-DB migration bootstrap, pgTAP (no Postgres/docker). `.orchestra/cr/MET-T04.md` from earlier run is now obsolete (not deleted).

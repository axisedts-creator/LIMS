# MET-T04 impl (writer)
- Files: NEW `db/migrations/20261114120000_instruments__add_getein_metis_driver.sql` (CR-C7-020: SET LOCAL ROLE lims_owner; then one INSERT, 14 H80E columns, generic, 0.1.0, caps host_query/qc true; no UPDATE); `apps/bridge-agent/testdata/sessions/metis-{api-down,oru-patient,q03-id-mismatch}.session.json`.
- registry.ts, options schema (§8) and CI registry check were already in place from MET-T01..T03; no change needed.
- [CONV] Session files: PID.5 emptied (repo synthetic scan allows no non-empty PID.5, ci-scripts "REAL repo"); metis-oru-patient raw_sha256 recomputed (hash = sha256 of first queued item, CR bytes). DOB/id sentinels stay.
- Run: registry 9/9 and ci-scripts pass; e2e 5/7 pass. 2 fail: sample-range NF + archive, because service/hostQuery.service.ts parseQuery rejects an empty barcode list. Needs a C7 CR, written at `.orchestra/cr/MET-T04.md`. Not edited (outside file list).
- Not verified: fresh-DB migration bootstrap and pgTAP (no Postgres/docker here).

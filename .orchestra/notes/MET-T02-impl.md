# MET-T02 impl (writer)
- Files: NEW drivers/getein_metis/index.ts (+ testdata/: 7 cases x raw/context/expected, SOURCE.md); EDIT drivers/registry.ts (registered geteinMetis).
- Driver: code getein_metis 0.1.0, hl7v2, status generic, capabilities per addendum §8, optionsSchema 5 keys; parse only (QRY -> messageKind other until MET-T03 adds extractHostQueryBarcodes/buildHostQueryReply).
- [CONV] reasons/warnings constant strings (qc_lists_differ, missing header record, record n skipped: ...); PID read for presence only; OBX-4 fallback warning obx3_empty_obx4_used; both-non-expiry QC lot -> first value + warning qc_lot_ambiguous.
- [CONV] time: OBX-14, else OBR-7, else MSH-7; slash and 14-digit forms; impossible stamp falls through. QC level through qc_level_map, unmapped passes raw. METIS_QC_ERROR on `Error` / `-1`.
- Tests run: drivers-getein-metis, ingest.getein_metis, drivers-registry, drivers-golden = 173/173 green. Full instruments suite: 4 files fail, none mine:
  ci-scripts "REAL repo: drivers and db/migrations agree" + drivers-truth-h80e-registry "REAL repo" (need MET-T04 g_drivers migration, CR-C7-020); signing.test Go fixtures (README.md missing, AG-T11).
- Open: ci-scripts "REAL repo ... synthetic" fails on MET-T01 files apps/bridge-agent/testdata/sessions/metis-{api-down,oru-patient,q03-id-mismatch}.session.json (PID-5 "Test Patient"); not my paths, needs MET-T01 owner (empty PID-5 or allowlist).
- Not run: tsc is red repo-wide on pre-existing contracts/ imports; no errors reported in getein_metis or registry.

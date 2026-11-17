# T-07 impl (writer)
- Files: `service/analyteVersions.service.ts`, `handlers/analyteVersions.handlers.ts` (+ `handlers/index.ts`), `repo/analytes.repo.ts` (value sets, AC-02.3 read); `repo/tests.repo.ts` update() table union widened; `service/revision.service.ts` BumpInput.stampOrderableId (analyte stamps its test's orderable); `probes/pending.json` -7 ops.
- Result: catalog suite 2327/2328 pass; the 1 failure is a test bug -> `.orchestra/notes/T-07-dispute.md` (stale If-Match in the REQ-SEC-082 hygiene test). tsc clean for touched files.
- [CONV] lock order: owning test's orderable -> analyte -> version(s) -> catalog_state (matches tests.service; draft-only writes skip the orderable lock). Draft create copies latest published, else newest version.
- [CONV] publish asserts catalog.test.manage then catalog.reference_range.publish in the handler before parsing; DB P0001 -> 409 catalog.version_in_use; 23505 draft/version_no race -> 409 common.version_conflict.
- Open: reference_range_set_id / critical_limit_set_id only format-checked (attach = T-08/T-09); formula_inputs not copied/validated (T-11); not run: real-Postgres trigger SQL test, full repo suite/linter.

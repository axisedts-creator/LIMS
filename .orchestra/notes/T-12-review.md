APPROVE

Re-review of round-1 items (commits abca82e, 1ca4f9c):
1. Depth: fixed. checkGraph rejects at `depthThrough + 1 > PANEL_MAX_DEPTH` (TRD §11 counts levels including the leaf test). The [ASSUMPTION] comment is gone. Tests now say: 3 panels allowed, 4 panels -> 400 /members, and ancestors count too (panelGraph.test.ts, panels.service.test.ts).
2. ordinal_set_values: fixed. Active values are returned sorted by sort_order asc and only when ordinal_set_code is set. Reads use selectRows with an explicit tenant_id on cs_*. Column names match the migration. A resolve test covers active/inactive values, a foreign set, and an analyte with no set.
3. uses_existing_material: fixed. It is selected and returned as a boolean. A test covers it being absent from specimen_requirements and returning specimen_type_codes [].

Note (not a defect): the [CONV] rule that a tenant cs_value_sets set shadows the global set with the same code is untested. It is recorded in T-12-impl.md.
Ran: the T-12-verify vitest set passed (6 files, 358 tests). `tsc --noEmit` shows 0 errors under modules/catalog. The errors that remain are pre-existing ones in contracts/ and packages/shared-ts.

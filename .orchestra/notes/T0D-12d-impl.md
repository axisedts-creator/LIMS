# T0D-12d impl (writer)
- contracts/routes.yaml: LD-112 comment + 20 C2 rows after staff.platform.dead_letter; LD-130 comment + 8 staff.quality rows after staff.quality.qc_run; LD-130 comment + 3 staff.smartreport rows after staff.smartreport.summary; all verbatim from IC §7 (174 routes).
- contracts/openapi/inventory.yaml: local schema Code -> InventoryCodedSetEntry (LD-115), both $refs updated; wire unchanged.
- Regenerated via `pnpm --dir tools/codegen codegen`: content changes only in packages/shared-ts/src/routes/generated.ts and packages/shared-dart/lib/src/routes.g.dart; other generated files show EOL-only diffs (no content change), not part of this task. Inventory mock is prism over the yaml [CONV] (no artifact).
- Verify (each leg of T0D-12d-verify.cmd run directly): contracts 30/30 (t0d-12d + registry-equality AC-0C-1.3), tools/codegen 652/652 (t0d-12d-generated, codegen-fresh, c12-openapi), services/api inventory-spec-load 3/3. All green.
- Open: the all-manifests build-nav tests (LD-131/LD-132) were not rerun here; per those rulings, rerun them once this lands on main.

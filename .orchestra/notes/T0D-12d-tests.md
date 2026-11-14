# T0D-12d tests (vitest; LD-112 routes + LD-115 inventory Code rename + LD-117 + LD-130 route rows)
- contracts/__tests__/t0d-12d.test.ts: 20 LD-112 rows + 11 LD-130 rows (3 smartreport after staff.smartreport.summary, 8 quality after staff.quality.qc_run): id/path/owner/permission, contiguous, order, LD comment lines, 174 total, no param/role-editor row; inventory.yaml: no local Code, InventoryCodedSetEntry same wire shape, both $refs, schema count 47.
- tools/codegen/__tests__/t0d-12d-generated.test.ts: committed generated.ts + routes.g.dart carry the 31 rows, ids == routes.yaml. Freshness = existing codegen.test.ts (codegen-fresh); registry-equality.test.ts (AC-0C-1.3, whole table vs IC §7) re-runs unedited.
- tools/codegen/__tests__/c12-openapi.test.ts: LD-117 edit, "Code" -> "InventoryCodedSetEntry" at 3 sites only (DTOS list, putInventoryTenantCode, schema(...)).
- services/api/src/core/__tests__/inventory-spec-load.test.ts: loadSpec(inventory.yaml) no "collides with a local definition"; Code string, InventoryCodedSetEntry object.
- Run all: `.orchestra\notes\T0D-12d-verify.cmd` (unchanged). Not yet run green; expected red until writer adds the rows + rename.

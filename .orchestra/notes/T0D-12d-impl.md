# T0D-12d impl (writer)
- contracts/routes.yaml: LD-112 comment line + 20 rows copied verbatim from IC §7, right after staff.platform.dead_letter (163 routes).
- contracts/openapi/inventory.yaml: local schema Code -> InventoryCodedSetEntry (LD-115 comment), both $refs (listInventoryCodedSet items, putInventoryTenantCode 200) updated; wire unchanged.
- Regenerated via `pnpm --dir tools/codegen codegen`: content changes only in packages/shared-ts/src/routes/generated.ts and packages/shared-dart/lib/src/routes.g.dart; other generated files show EOL-only diffs (no content change). Inventory mock is prism over the yaml [CONV] (no artifact).
- Green: t0d-12d.test.ts, t0d-12d-generated.test.ts, codegen.test.ts, inventory-spec-load.test.ts.
- Red: c12-openapi.test.ts (2, hard-codes "Code" vs LD-115) and registry-equality routes (7 pre-existing C3 rows not in IC §7). See T0D-12d-dispute.md.

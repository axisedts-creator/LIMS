# T0D-12d tests (vitest; LD-112 routes + LD-115 inventory Code rename)
- contracts/__tests__/t0d-12d.test.ts: 20 LD-112 rows (id/path/owner/permission, contiguous after staff.platform.dead_letter, order, comment line, 163 total, no param/role-editor row); inventory.yaml: no local Code, InventoryCodedSetEntry same wire shape, both $refs, schema count 47.
- tools/codegen/__tests__/t0d-12d-generated.test.ts: committed generated.ts + routes.g.dart carry the 20 rows, ids == routes.yaml. Freshness = existing codegen.test.ts (codegen-fresh); registry-equality.test.ts (AC-0C-1.3) and c12-openapi.test.ts re-run unedited.
- services/api/src/core/__tests__/inventory-spec-load.test.ts: loadSpec(inventory.yaml) no "collides with a local definition"; Code string, InventoryCodedSetEntry object.
- Run all: `.orchestra\notes\T0D-12d-verify.cmd`. Run now: red (rows absent; Code not renamed). Not verified green.

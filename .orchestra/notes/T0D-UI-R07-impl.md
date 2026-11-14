# T0D-UI-R07 impl
- Added `packages/ui/scripts/raw-style-pending.json` (8 dirs), generated from a scan of the current tree with the test's own `findViolations` (71 hits, LD-140). Test file untouched.
- [CONV] One entry per feature chunk dir (`apps/web/src/features/<chunk>`) so the lead drops a line when that chunk's restyle (RS-Cx) lands.
- [CONV] `apps/web/src/app` and `apps/portal/src/app` listed whole: hits sit under `app/(staff)/catalog/...`, and the test's dir regex `[\w.@-]+` rejects `(staff)`, so no narrower entry is allowed.
- Hits outside features: portal.css (hex + px radius), catalog route pages (inline style). Some hits are hex fixtures in `__tests__` (catalog, lab); they are covered by the feature dir and must be fixed or kept pending when that chunk restyles.
- Verify: `pnpm --dir packages/ui exec vitest run scripts/__tests__/no-raw-style-literals.test.ts`: 42/42 pass.
- Open: should test fixtures under `__tests__` be exempt from the scan? That's the tester's/lead's call.

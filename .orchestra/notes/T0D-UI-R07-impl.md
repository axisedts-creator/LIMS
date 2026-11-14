# T0D-UI-R07 impl
- Added `packages/ui/scripts/raw-style-pending.json` (8 dirs), generated from a scan of the current tree with the test's own `findViolations` (71 hits, LD-140). Test file untouched.
- [CONV] One entry per feature chunk dir (`apps/web/src/features/<chunk>`) so the lead drops a line when that chunk's restyle (RS-Cx) lands.
- Review fix: web entry narrowed to `apps/web/src/app/(staff)/catalog` (test regex now allows `(group)`/`[param]`). `apps/portal/src/app` stays whole: its hit is `portal.css` at app root, and entries must be directories.
- Hits outside features: portal.css (hex + px radius), catalog route pages (inline style). Some hits are hex fixtures in `__tests__` (catalog, lab); they are covered by the feature dir and must be fixed or kept pending when that chunk restyles.
- Verify: `pnpm --dir packages/ui exec vitest run scripts/__tests__/no-raw-style-literals.test.ts`: 42/42 pass.
- Open: should test fixtures under `__tests__` be exempt from the scan? That's the tester's/lead's call.

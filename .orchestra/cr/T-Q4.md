Title: CR-C16-0xx: tsconfig.base NodeNext breaks @lims/api typecheck on contracts/ports and shared-ts imports
From chunk: C16            To owner: C0-0A (tsconfig.base.json / contracts/ports / packages/shared-ts)
Type: bug
Blocking? yes (T-Q4 verify runs `turbo run build typecheck`; @lims/api#typecheck fails before any T-Q4 file is reached)
Problem: `.orchestra/out/T-Q4-verify.log`: TS2835 (extensionless relative imports in contracts/ports/*.ts under moduleResolution NodeNext) and TS5097 (packages/shared-ts/src/bsdate/index.ts:2, formula/index.ts:3 import `.ts` without allowImportingTsExtensions). None of these files are in C16's ownership; T-Q4 files (apps/web/src/features/engagement) do not exist yet in this worktree.
Proposed change (exact): in contracts/ports/*.ts add `.js` extensions to relative imports; in packages/shared-ts/src/{bsdate,formula}/index.ts use `.js` (or enable allowImportingTsExtensions with noEmit in the consumer tsconfig). Owner to choose.
Backward compatible? yes
Tenant/security impact: none
Alternatives considered: set moduleResolution=Bundler in services/api/tsconfig.json (also not C16-owned).
Tests that will prove it: `pnpm turbo run build typecheck` green.

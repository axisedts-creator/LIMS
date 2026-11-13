<<<<<<< HEAD
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
=======
Title: CR-C16-T-Q4-a: W6 [Call next] page shortcut Alt+N contradicts C0 global Alt+N
From chunk: C16           To owner: spec owner of C16 04-UI-UX W6 / C0-0D (shell shortcuts)
Type: spec
Blocking? no — [Call next] stays reachable by its button; code uses `Alt+C` as a cited stopgap (apps/web/src/features/engagement/components/QueueConsole.tsx, shortcut register) until ruled. Same root as CR-C7-WEB-T03-a (.orchestra/cr/WEB-T03.resolved-202611091015.md).
Problem: spec/chunks/C16-patient-engagement/04-UI-UX.md:227 declares W6 [Call next] `Alt+N`, and :231 says "`Alt+N` with an empty queue → toast". spec/chunks/C0-foundation-contracts/04-UI-UX.md:317 reserves global `Alt+N` (focus navigation), and AC-0D-7.5 requires the registry to throw on a page key that conflicts with a global key. No implementation can satisfy both.
Proposed change (exact): in C16 04-UI-UX W6 change [Call next] `Alt+N` to `Alt+C` (free on page `staff.engagement.queue`; not used by R/S/D/K/T/I or any global key) at :227, and change :231 to "[Call next] (`Alt+C`) with an empty queue → toast "No one is waiting."".
Backward compatible? yes
Tenant/security impact: none
Tests that will prove it: t-q4.source.test.ts / t-q4.console.test.tsx shortcut tests (currently key-agnostic: "call next" shortcut whose key is not global) may then pin the ruled key.
>>>>>>> main

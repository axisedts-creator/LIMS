# T0B-SYNC-2 debug
- CAUSE: not a code bug. Writer wrote no code (impl note: BLOCKED). `createSyncPart2Handlers`/`syncPart2Handlers` do not exist, and prereq T0C-SYNC-2 (contract, migration 20261117260000, probe rows, SyncEntityType schema) is only on lane/C0-0M (a16b1980d), not on lane/C0-0H (verified: no migration file, no SyncEntityType outside tests). Hence 22 failures (8 files), e.g. `Cannot read properties of undefined (reading 'enum')` at sync2.registry.static.test.ts:126.
- NO FIX APPLIED: implementing without the contract would invent table/column/error names (CLAUDE.md forbids); merging lane/C0-0M was refused by the harness for the writer and is a lead action.
- NEXT: lead merges lane/C0-0M (or main once it holds T0C-SYNC-2) into lane/C0-0H, then re-queue the writer for T0B-SYNC-2 impl. Tests are not disputed.

## round 2
- CAUSE unchanged: no migration 20261117260000 on lane/C0-0H and handlers `createSyncPart2Handlers`/`syncPart2Handlers` exist only inside tests. Contract T0C-SYNC-2 (a16b1980d, lane/C0-0M) still not merged here.
- NO FIX APPLIED: writing impl without contract = inventing table/column/error names (forbidden). Tests not disputed.
- NEXT: lead merges lane/C0-0M into lane/C0-0H, re-queue writer for T0B-SYNC-2 impl.

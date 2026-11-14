# T0A-08 debug
- Cause 1 (fixed): shared-ts lacked `"@lims/contracts":"workspace:*"` (LD-03) so the package did not resolve. Added to package.json + `pnpm install --offline` (lockfile updated).
- Cause 2 (open, not mine): contracts/package.json on this branch has no "exports" ("./ports/common", "./ports/generated/error-codes") and ports/generated/ is absent. C0-0C owns both; they exist on lane/C0-0C (T0C-05) but are not merged into lane/C0-0A. Now fails with "Cannot find module ...@lims\contracts\ports\common" (22 errors/validation tests).
- Fix needed: orchestrator merges lane/C0-0C (or main once it lands) into lane/C0-0A, re-run `pnpm install --offline`, re-run verify.cmd. No impl-code change can fix this without editing C0-0C paths.
- Round 2 recheck: main and lane/C0-0A still lack C0-0C exports (lane/C0-0C has them, unmerged). Still blocked on merge; no impl change possible.
- Round 3 recheck: main (cfff0e2) still has no contracts "exports"; lane/C0-0C does. Same blocker, unmerged C0-0C. Not an impl bug; no C0-0A-owned change fixes it. Orchestrator must merge lane/C0-0C, `pnpm install --offline`, re-run verify.cmd.
- Round 4 recheck: main (1841a84) still has no contracts "exports"; lane/C0-0C has it, unmerged. Same blocker, no C0-0A-owned fix. Orchestrator: merge lane/C0-0C, `pnpm install --offline`, re-run verify.cmd.
- Round 5 recheck: main (1841a84) still lacks contracts "exports"; lane/C0-0C has it, unmerged. Same blocker, no C0-0A-owned fix. Orchestrator: merge lane/C0-0C, `pnpm install --offline`, re-run verify.cmd.
- Round 6 recheck: main (1841a84) and lane/C0-0A still lack contracts "exports"; lane/C0-0C has it, unmerged. Same blocker, no C0-0A-owned fix. Orchestrator: merge lane/C0-0C, `pnpm install --offline`, re-run verify.cmd.

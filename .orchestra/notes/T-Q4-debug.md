Cause: verify failed in @lims/api typecheck (TS2835/TS5097) on contracts/ports/* and packages/shared-ts/src/{bsdate,formula}; NodeNext import-extension errors, not in T-Q4 code.
Also: log shows ^C "Terminate batch job" on ui/shared-ts, so run was partly interrupted; T-Q4 impl files absent in this worktree.
Fix: none applied, paths not owned by C16 (CLAUDE.md). Filed .orchestra/cr/T-Q4.md for C0-0A. Re-run verify after CR lands.

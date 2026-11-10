# AN-T17 impl
- Files: `components/{ExportDialog,ScopeBanner}.tsx`, `server/{exports.server.ts,actions.ts}` (apps/web/src/features/analytics); LD-83 kit edit: `packages/ui/src/components/RadioGroup/RadioGroup.tsx` (per-option `isDisabled?`, additive; nothing else in packages/ui). ExportDialog `as never` cast removed.
- Tests: an-t17 verify 28/30 in full run; PDF-disabled tests now pass. The 2 failures are the known cold-import timeouts in `an-t17.scope` (cascade); alone it passes 5/5.
- packages/ui: 983/984; only fail `batch2-data` DataTable "virtualize={false}" timed out at 5000ms under load (untouched by this change, not RadioGroup).
- [CONV] Idempotency-Key = crypto.randomUUID per format attempt, reused on retry; report_code/format/key validated in BFF.
- Open: "Verify now" has no known C2 step-up route -> optional `onVerify`, default reload. 429 `{time}` unavailable via action -> "Try again at a later time." Copy not registered in core messages.ts (not owned).
- Not run: typecheck output for packages/ui was empty (clean); web app typecheck/lint not run.

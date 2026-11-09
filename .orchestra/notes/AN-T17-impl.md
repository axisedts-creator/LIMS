# AN-T17 impl
- Files: `components/{ExportDialog,ScopeBanner}.tsx`, `server/{exports.server.ts,actions.ts}` (apps/web/src/features/analytics). Kit-only imports (Banner, Dialog, RadioGroup, DescriptionList, Checkbox, Button, Toast).
- Tests: 27/30 pass. BLOCKED: "PDF is disabled…" — kit RadioGroup has no per-option isDisabled -> `.orchestra/cr/AN-T17.md` (ui-kit CR). ExportDialog already passes `isDisabled` on the pdf option; passes once kit honours it.
- 2 scope tests timed out only in the full run (cold import on a slow box, 46–88s; cascade leaks DOM to the next test). `an-t17.scope` alone: 5/5 pass in 10s.
- [CONV] Idempotency-Key = crypto.randomUUID per format attempt, reused on retry; report_code/format/key validated in the BFF before any request.
- Open: "Verify now" has no known C2 step-up route -> optional `onVerify` prop, default reload. 429 `{time}` unavailable via action -> "Try again at a later time." Copy not registered in core messages.ts (not owned); literals as in billing/catalog.

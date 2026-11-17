APPROVE
Scope: git diff 907cc5f..HEAD (only `__tests__/manifest.test.ts` + orchestra notes; no implementation change in this range).
- manifest.test.ts:83-85 adds exactly the six P1-P6 operationIds the ruling (C6-T18-ruling.md) named, with the comment it required; all six match 02-TRD.md:646-651 verbatim. P7/PP1/PP2 and previewReportTemplate (T5) are still in the 501 list.
- P1-P6 are really wired (handlers/portal.handlers.ts) and covered by portal.*.test.ts, so taking them off the 501 list does not hide stubs. No other assertion was weakened; the count check (IMPLEMENTED.size) still holds.
- Only owned paths touched; no PHI, secrets or invented names in the diff.
- Ran the verify command (3 files): 129/129 pass, no stubs.
Not re-checked in this round: templates.service.ts (unchanged since 6713e90). Known issues outside this task: tsc errors in contracts/ports/IdentityPort.ts and shared-ts bsdate, and the repository.static.test failure on reports.service.ts.

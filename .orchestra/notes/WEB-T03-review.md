APPROVE

Scope: git diff 11e32ecd..HEAD (WEB-T03 round 2 after rulings + LD-79).
- LD-79: SCR-05 registers Alt+I "New instrument" via shortcuts.register (manage only, unregister on unmount via returned disposer); help entry Alt+I; Alt+N never registered. LD-79 cited in code comment.
- Ctrl+Enter capture handler matches C0 04-UI-UX.md:321 (Forms Ctrl+Enter submit); stopPropagation prevents double submit; submit() is guarded by inFlight/done.
- validateInstrument mode mapped edit->'update' (signature 'create'|'update', forms/instrument.ts:84) — fixes prior type mismatch.
- Test edits match ruling items 1,2,4,5,6,7 and round-2 ruling (Vendor/Model, Unmapped codes) exactly; no test weakened beyond the rulings.
- Error codes unchanged (instruments.code_duplicate, instruments.capability_not_supported, common.version_conflict, auth.mfa_required). No PHI/secrets. Only owned paths (features/instruments/*) plus notes. No DB/RLS in this task.
Checks run: vitest.web-t03 config: 2 files, 98/98 pass. tsc: no errors in WEB-T03 implementation files.
Non-blocking: tsc reports type errors in test files (onUnhandledRequest option type, spread of untyped summary()/full() helpers, web-t03.components.test.tsx:76,113..212) — same pattern exists in web-t02/web-t06 tests; tester-owned, follow-up for test typing, not a WEB-T03 impl defect.

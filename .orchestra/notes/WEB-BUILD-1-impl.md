# WEB-BUILD-1 impl (writer) - BLOCKED by CR .orchestra/cr/WEB-BUILD-1.md
- config.actions.ts: getLabSettingsAction, listDeltaRulesAction now `export async function` (same bodies/names) [LD-194].
- lab shared.tsx: useRef hook moved to new 'use client' useSerial.ts; CollectDispatch/ReceiveScreen import it; NO_ACCESS stays plain [LD-194].
- 'use client' first line: packages/ui DiffTable.tsx, PageShell.tsx (extra, flagged by guard) [LD-194].
- Tests: build-boundaries 16/16 pass (after ruling revision).
- Real build run: compile OK ("Compiled successfully in 26.4s", 8 boundary errors gone); TypeScript step FAILS: 279 errors/165 files (160 test files, 2 portal via rs-c6 test import, 3 catalog ui-kit prop mismatches). Over the 15-file cap and needs API decisions, so I stopped and filed the CR (LD-194 RULES b).
- Before this fix: no apps/web/.next existed in this lane, so verify had not built web before (likely turbo cache/filter; not proven). No passing build output to paste.

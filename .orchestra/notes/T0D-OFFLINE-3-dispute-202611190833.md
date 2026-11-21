# T0D-OFFLINE-3 dispute (debugger round 15)
Failing: apps/web/src/features/frontdesk/__tests__/rs-c4.screens.test.tsx:74 "Daily cash (open shift)" snapshot mismatch.
Diff is purely additive: new stat row + chart card section before "My shift" (T0D-UIDASH-1, LD-353, already landed). Not caused by OFFLINE-3 (done_when 1-6 touch registration/billing receipts/collection, not Daily cash UI).
Needed: tester/lead re-record only this snapshot via `pnpm --dir apps/web exec vitest run --config src/features/frontdesk/__tests__/vitest.rs-c4.config.ts -u src/features/frontdesk/__tests__/rs-c4.screens.test.tsx`. No implementation change possible.

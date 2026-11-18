# T0B-SALES-1 dispute (writer, after LD-356, 2026-11-18)
Verify (tests/partners/T0B-SALES-1.pg.sh) run 1 and run 2, code unchanged, tests at 420d919ca:
- main command: 1 failed | 3511 passed | 1 skipped (85 files, 84 green) — both runs identical.
- timing command (perf + real-modules-boot, --retry 2): 6/6 green both runs.
- All sales, collector, partners, probe, repositories.test.ts and handovers/read.test.ts files GREEN (LD-356 fixes worked).

Only red: src/modules/homecollection/__tests__/sync/guards.test.ts:255
"requires_reference method: ... with reference -> applied (tenant B settings)" — expected ['applied'], got ['rejected'].
This file and the guard code (conflict.service.ts payment(), sync.service.ts) are not touched by this task.

Likely cause (TESTS_WRONG, isolation): line 252 sets tenant B payment_methods with setSettings = plain
`UPDATE homecollection.settings ... WHERE tenant_id = B` (snapshot/helpers.ts:239). Several earlier files delete or replace the shared tenant B
settings row (settings/helpers.ts resetSettings/restoreSettings DELETE+INSERT, repositories.test.ts:207 DELETE then lazy insert).
If the row is absent or replaced when guards runs, the UPDATE is a no-op and pushWorld (snapshot/helpers.ts:162, ON CONFLICT DO NOTHING)
seeds/keeps a row whose payment_methods do not hold fonepay_qr as written by line 252, so the payment is rejected (conflict.service.ts:95).
Was green in rounds 5/6, red now: file order changed (vitest sequencer) after LD-356 removed the seedWorld DELETE.
Not proven: an isolated run of guards.test.ts alone needed an approval this session did not get.

Ask: isolation-only fix for guards.test.ts:252, e.g. upsert tenant B settings (INSERT ... ON CONFLICT (tenant_id) DO UPDATE SET payment_methods)
before pushWorld, or call setSettings AFTER pushWorld; no assertion changed. No implementation change. Not 3x green.

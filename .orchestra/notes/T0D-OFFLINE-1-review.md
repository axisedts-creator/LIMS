CHANGES
Verified: offline1 81/81 pass, rs-c2 74/74 pass (run locally). Routes, bodies and result shapes match packages/api-client-ts/src/core.ts (pushSyncBatch, registerSyncDevice with Idempotency-Key, getSyncStatus, ackDeviceWipe, /v1/core/health/live). No logging, no secrets, only owned paths, fake-indexeddb pinned exactly (dev only).

1. apps/web/src/core/offline/store.ts:127-146 — the 10-wrong-PIN wipe can be bypassed. The wipe runs only AFTER the PBKDF2 derive/unwrap (hundreds of ms) of the attempt that reaches the limit. If the page is closed/reloaded in that window, the persisted counter is >= 10 but the store is not wiped, and every later unlock() just charges 11, 12, ... and still checks the PIN: unlimited guesses (the header comment at store.ts:4-5 promises the opposite; done_when (2) "10 wrong PINs wipe the store").
   Fix: in unlock(), right after the charging transaction returns `failed`, add
   `if (failed > maxFailures) { await wipe('wiped'); return { ok: false, reason: 'wiped' }; }`
   before reading the keyring / deriving the key (keep the existing `failed >= maxFailures` wipe at line 146).
   Test (offline1.store.test.ts, "PIN failures wipe the store"): set up a store, lock, make 9 wrong unlocks, then write the state record directly through the raw DB with `failed: 10` (simulating a 10th attempt interrupted before its wipe), reopen, and assert `unlock(PIN)` (the RIGHT PIN) returns `{ ok: false, reason: 'wiped' }` and status().state === 'wiped'.

Notes, not blocking: the service worker is not registered anywhere yet and no precache manifest is generated, so done_when (1) is only met at code level (writer deferred to T0D-OFFLINE-2: needs a session free shell route); expired stores are refused at unlock but only wiped when purgeExpired() is called, which nothing calls yet — wire both in OFFLINE-2.

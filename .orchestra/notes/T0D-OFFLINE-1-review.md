APPROVE
Re-review after review fixes (308195777, 72980f2b5). Verified locally: offline1 82/82 pass, rs-c2 74/74 pass.

Previous defect 1 (10-wrong-PIN wipe bypass via reload mid derive) is fixed: store.ts unlock() now wipes when the charged counter exceeds maxFailures, before reading the keyring or deriving any key, so the PIN is never checked again. The new test in offline1.store.test.ts ("a 10th attempt interrupted before its wipe ...") writes failed: 10 through the raw DB, reopens, and asserts the RIGHT PIN returns reason 'wiped', state 'wiped', and no plaintext remains.

Re-checked: engine (one flight, Web Locks ifAvailable / BroadcastChannel fallback, 50 ops / 1 MB, full jitter capped at 300000 ms, Retry-After, per op settlement in one tx), outbox (UUIDv7 monotonic, append atomic with local change), sw.js (no API or navigation responses cached, SKIP_WAITING only on message). No logging, no secrets, only owned paths, fake-indexeddb pinned exactly as a devDependency.

Carried forward, not blocking (for T0D-OFFLINE-2): the service worker is not registered and no precache manifest is generated yet (needs a session free shell route); purgeExpired() is not called anywhere yet (expired stores are refused at unlock but only wiped when it runs); a conflict result without conflict_id stays in the outbox.

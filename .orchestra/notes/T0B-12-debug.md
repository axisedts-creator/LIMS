# T0B-12 debug (2026-11-07)
- Failures: 2 GATE tests (64/66 pass). They assert a Storage base-URL env `LIMS_CORE_STORAGE_*URL` and bucket admin endpoints are recorded in SP-4.md / C0 TRD / C1 TRD. grep: neither is recorded (only `LIMS_CORE_STORAGE_KEY_FILE`).
- Cause: not a code defect. Spec gap; LD-54 forbids guessing env names or vendor endpoints, and spec/ is read-only for me.
- Fix: none in implementation (any value I add would be invented). Test is correct per LD-54, so no dispute. Blocked on lead ruling for .orchestra/cr/T0B-12.provisioning-contract.md; then record the contract and wire the HTTP transport in db/provisioning/create-storage-buckets.mjs.

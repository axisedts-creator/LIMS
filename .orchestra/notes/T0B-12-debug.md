# T0B-12 debug (2026-11-07)
- Failures: 2 GATE tests (64/66 pass). They assert a Storage base-URL env `LIMS_CORE_STORAGE_*URL` and bucket admin endpoints are recorded in SP-4.md / C0 TRD / C1 TRD. grep: neither is recorded (only `LIMS_CORE_STORAGE_KEY_FILE`).
- Cause: not a code defect. Spec gap; LD-54 forbids guessing env names or vendor endpoints, and spec/ is read-only for me.
- Fix: none in implementation (any value I add would be invented). Test is correct per LD-54, so no dispute. Blocked on lead ruling for .orchestra/cr/T0B-12.provisioning-contract.md; then record the contract and wire the HTTP transport in db/provisioning/create-storage-buckets.mjs.

## Round 2
- Same 2 GATE failures (64/66). Re-grepped SP-4.md, C0 TRD, C1 TRD: still no `LIMS_CORE_STORAGE_*URL` env name and no `/storage/v1/bucket` endpoint recorded.
- Cause: unchanged spec gap, not an implementation defect. Test is correct per LD-54, so no dispute. No code change: any value I add would be a guess.
- Blocked on the lead ruling for `.orchestra/cr/T0B-12.provisioning-contract.md`.

## Round 3
- Same 2 GATE failures (64/66); the other 64 pass. Re-grepped SP-4.md, C0 TRD, C1 TRD: 0 hits for `LIMS_CORE_STORAGE_*URL` or a bucket admin endpoint.
- Cause: unchanged spec gap, not an implementation defect. Test is correct per LD-54, so no dispute. No code change: any env name or endpoint I add would be a guess.
- Needs the lead to rule on `.orchestra/cr/T0B-12.provisioning-contract.md` and record the contract. Then wire HTTP transport in `db/provisioning/create-storage-buckets.mjs`.

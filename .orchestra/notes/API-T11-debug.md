# API-T11 debug
Cause: both failures in boot.test.ts, none in T11 code. (1) stale `IMPLEMENTED` list lacks `submitMessageBatch` (E04 done in T09) -> stub assertion fails. (2) "boots and mounts" 30 s timeout is a parallel-load flake; passes alone.
Fix: none in implementation (test edit forbidden). Wrote API-T11-dispute.md. T11 suites (handlers 12, service 44, contract 18) all pass.

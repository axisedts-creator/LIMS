# API-T11 dispute (debugger)
Remaining failure: `boot.test.ts` > "stub submitMessageBatch throws common.internal" (boot.test.ts:39-45, `IMPLEMENTED` list).
Test is stale: plan row API-T09 (spec/chunks/C7-instrument-integration/06-IMPLEMENTATION-PLAN.md:56) makes E04 `submitMessageBatch` a real handler (`handlers/ingest.handlers.ts`), so it must not be a stub. Test omits it from `IMPLEMENTED`. No implementation fix possible (reverting T09 handler would break T09). Not caused by T11; fix = add 'submitMessageBatch' to IMPLEMENTED (test owner).
Other failure "boots and mounts ..." timeout: passes alone (49/50 in isolation, only the stale stub fails); load flake of 30 s limit in parallel run.

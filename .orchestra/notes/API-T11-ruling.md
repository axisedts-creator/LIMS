TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
1. The failing assertion is boot.test.ts:39-45 (`IMPLEMENTED` list). It expects `submitMessageBatch` to still be a stub that throws common.internal.
2. spec/chunks/C7-instrument-integration/06-IMPLEMENTATION-PLAN.md:56 (API-T09) makes E04 the real ingest pipeline. That task added `handlers/ingest.handlers.ts`, which is wired in handlers/index.ts:35.
3. Plan row :48 (API-T01) only requires "empty handlers" until a later task replaces them. The test's own comment (boot.test.ts:38) says that later task moves its id into `IMPLEMENTED`. API-T09 never did that, so the test is stale. This is not caused by API-T11.
4. Change: in boot.test.ts `IMPLEMENTED`, add `'submitMessageBatch', // API-T09`. Leave everything else as it is.
5. `submitHostQuery` (API-T10, plan :57) is not merged in this lane. handlers/index.ts:35 has no host-query handler, so it stays a stub. Do not add it here.
6. Timeout of "boots and mounts …": the writer says it passes when run alone. That is a test-load issue, not a spec matter, and this ruling does not cover it.

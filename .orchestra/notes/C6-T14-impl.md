# C6-T14 impl (R7 bulkReleaseReportVersions)
Files: services/api/src/modules/reporting/service/release.service.ts (mode 'bulk', bulkRelease, assertBulkLimit), handlers/release.handlers.ts (R7 handler). index.ts unchanged (spreads releaseHandlers). No code change this round (tests revised per ruling).
Run: verify.cmd scope + release.handlers = 189/189 pass (4 files, 58 s). Load p95 now under 8 s in isolation.
[CONV] bulk = release.service releaseVersion mode 'bulk': no If-Match, skips instead of throws, held writes nothing; one savepoint per id via ctx.tx.savepoint (fallback: none).
[CONV] unexpected per-id failure -> savepoint rollback + outcome `not_ready`, code-only warn log (R7 enum has no "error"; CR candidate, not filed).
[CONV] order: ctx check -> body (400) -> user actor -> IdentityPort.assertRole(bulk_release) -> bulk_release_max (422) -> ids.
OPEN (test infra, not impl): full `vitest run src/modules/reporting` in parallel -> load test busy-spin sleep starves other files (8x "Hook timed out in 10000ms", p95 8.0-8.5 s). Fix: run load file alone / `fileParallelism:false` for it.

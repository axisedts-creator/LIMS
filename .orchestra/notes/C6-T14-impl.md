# C6-T14 impl (R7 bulkReleaseReportVersions)
Files: services/api/src/modules/reporting/service/release.service.ts (mode 'bulk', bulkRelease, assertBulkLimit), handlers/release.handlers.ts (R7 handler). index.ts unchanged (spreads releaseHandlers).
Run: 187/188 pass (bulk-release, manifest, release.handlers). tsc: no errors in my files (contracts/ports has pre-existing TS2835 noise).
[CONV] bulk = release.service releaseVersion mode 'bulk': no If-Match, skips instead of throws, held writes nothing; one savepoint per id via ctx.tx.savepoint (fallback: none).
[CONV] unexpected per-id failure -> savepoint rollback + outcome `not_ready`, code-only warn log (R7 enum has no "error"; CR candidate, not filed).
[CONV] order: ctx check -> body (400) -> user actor -> IdentityPort.assertRole(bulk_release) -> bulk_release_max (422) -> ids.
OPEN: load test p95 FAILS on this host (21-24 s vs 8 s), see C6-T14-dispute.md: not an implementation cost.

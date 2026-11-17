APPROVE
Scope: the diff 3c734cc0..HEAD changes notes only (LD-69 two-process verify.cmd), so I also reviewed the T14 code commits d3f97d3a (release.handlers.ts R7 and release.service.ts bulk mode) and 6163cb11/de2aa4e0/56a8789d (tests and fake DB memo).
- Names match the spec verbatim: `bulkReleaseReportVersions`, `reporting.report.bulk_release`, `reporting.bulk_release_too_large` (422, 03-IC), the outcome enum from 02-TRD §6.3 R7, `release_mode 'bulk'` and `bulk_release_max` (default 200).
- Rule 7 / E5: each id runs in its own `ctx.tx.savepoint`. The core Tx (core/db/tx.ts:87) always provides it, and on failure it does `ROLLBACK TO` and then rethrows, so the outer transaction stays usable. Held ids write nothing, the same as manual rule 2.
- Order of checks: auth, then body (maxItems 200 gives 400), then user actor, then assertRole (aal2 gives `auth.mfa_required`), then the tenant limit (422), then the ids. A missing IdentityPort fails closed. Every SQL statement binds tenant_id. Foreign ids are answered `not_found` and reveal nothing. The warning log carries only the error code (no PHI). No secrets.
- No migration in this task, so there is no RLS change to check. The idempotency key and rate tier are enforced by the pipeline and asserted in the contract test.
- Tests cover AC-07.1–07.4, E5, A7 and T13. The load test checks p95 ≤ 8 s, linear cost and a bound on statements per id.
- I ran verify.cmd myself (2026-11-08 05:52): bulk-release.test + manifest 103/103 pass; bulk-release.load alone 4/4 pass.
Non-blocking: the load test leaves about 2 s of headroom, so it can fail when other lanes load the host CPU (debug note 05:47). Re-run it alone if it fails.

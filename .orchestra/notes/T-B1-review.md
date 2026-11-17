APPROVE
Diff 75d1b39f..HEAD reviewed against TRD §5 S12-S14, §7.2, §8.1, §8.2, 05-SCHEMA bookable_items, engagement.yaml (S12/S13 error codes, StaffBookableItem), US-EN-26.1-3.
- Names verbatim: engagement.bookable_item.manage, engagement.sync_bookable_items(_nightly), job_key bookable:<tenant_id>, max_attempts 5, catalog.test_inactive / common.not_found / common.version_conflict.
- Consumer active is correct: CR-C16-013 ACCEPT (08 line 601); 01-CHUNK-MAP §5 and 03-IC row 19 list C16 as consumer. Unknown entity_type enqueues; duplicates collapse on job_key.
- Cron 01:40 Asia/Kathmandu = `55 19 * * *` UTC (manifest requires UTC fields). Tenant bound on every statement; tenant from ctx only; no PHI/secrets in logs; only owned paths (no migration, so no RLS change in scope).
- Price snapshot: priceFor({context:{}, priority:'routine'}) tenant default; catalog.no_price -> NULL price, other errors propagate.
- Tests rerun 2026-11-13: api bookable 20/20, worker bookable 38/38 pass. Not run: full typecheck/lint, real DB/RLS.

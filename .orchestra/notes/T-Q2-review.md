APPROVE
# T-Q2 review (diff 9cfd6653..959358fd)
- Names verbatim: operationIds Q3–Q7, `engagement.queue.operate`, `engagement.queue_closed`, `engagement.queue_token_invalid_transition` (02-TRD §5 l.499–503, l.993–994), `engagement.close_queue_day` (02-TRD l.678), QueueToken fields match contracts/openapi/engagement.yaml:9447.
- done_when met: numbering via queue_day_counters ON CONFLICT DO NOTHING + UPDATE … RETURNING on business date in tenant tz (TRD §4.10 l.369); call-next SELECT … ORDER BY priority DESC, issued_at, id FOR UPDATE SKIP LOCKED LIMIT 1 (l.370), board_version bumped.
- State machine matches 03-APP-FLOW §4.3 T-1..T-9 (recall call_count<9, T-6 same day, T-9 active + same centre). Permission floor before any query; row centre asserted; every statement binds tenant_id (REQ-SEC-024); version-conditional UPDATEs under row lock. No PHI in token body/logs (US-EN-21.6), no secrets, no DDL/RLS in scope, paths inside C16 module/worker job dir.
- Tests: 20 parallel issues, 2 (and 3) parallel call-next, every transition, day rollover with fake clock (API + cron). Ran verify: api 99/99, worker 13/13.
- Non-blocking notes (no change required now):
  1. T-10 (03-APP-FLOW l.256) includes `skipped` but 02-TRD l.678 does not; impl follows TRD. Raise CR if `skipped` must expire.
  2. cron.ts:484 derives the date from ctx.now(); a run/retry delayed past 00:00 NPT would target the new day. Graphile backoff makes this unlikely with maxAttempts 3; consider `business_date <= businessDate(now − 12h)` later.

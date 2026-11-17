# T-Q2 impl
- New: api `repository/token.repo.ts`, `service/token.service.ts`, `handlers/token.handlers.ts` (Q3-Q7, wired in handlers/index.ts); worker `jobs/engagement/cron.ts` (+ index.ts: task + frozen crontab `5 18 * * *` per_tenant). queue.service.ts: only `export` added to parseIfMatch/invalid.
- Results: API engagement 698 pass / 0 fail (93 token tests). After ruling (tests revised, no impl change): verify cmd green — api 99/99, worker close_queue_day 13/13.
- [CONV] business date = ctx.now() in tenant tz (IdentityPort.getTenantSettings, fallback Asia/Kathmandu); cron uses Asia/Kathmandu (P-15).
- [CONV] mutating ops lock the token row (FOR UPDATE) then do version-conditional UPDATEs; transfer inserts the new token first, then marks the old one; board_version bumped on call-next, recall, serve, complete, skip, cancel, transfer (both queues), not on issue.
- [CONV] Q4 keyset paging on id (uuidv7 = issue order), cursor = base64url(id); transfer keeps priority + booking_id; queue_enabled absent row = off.
- Open: cron does not expire `skipped` or earlier unclosed days (spec conflict, not asserted); tsc shows no errors in my files (pre-existing contracts/ports TS2835 noise elsewhere); worker suite has unrelated pre-existing failures (billing/reporting timeouts, xlsx).

# T-Q3 impl (Q8 pair/list/revoke, Q9 board, queueDisplayToken resolver)
- New: engagement/auth/display.resolver.ts, repository/display.repo.ts, service/display.service.ts, handlers/display.handlers.ts. Edited: index.ts (real resolver), handlers/index.ts (spread displayHandlers).
- Tests: engagement vitest suite 15 files, 780 passed / 2 skipped (incl. display.resolver + display.board). tsc: no errors in the new files. pgTAP db/tests/engagement/T-Q3_resolve_display.test.sql NOT run (no psql/pg_prove).
- [CONV] resolver: junk credential (not ^[A-Za-z0-9_-]{43}$) -> undefined with no DB call; else one `SELECT * FROM app.engagement_resolve_display($1)` with sha256 bytea.
- [CONV] board: ETag = max board_version of the display's own-centre queues; 304 reads only display row + queues; waiting = count(*) per queue (no business-date filter; close_queue_day expires old tokens).
- [CONV] pair: foreign/unknown centre or queue ids -> common.not_found (identical). revoke of an already revoked display -> 200 unchanged.
- Open: missing booking_centres row -> centre_display_name '' (spec silent); last_seen_at never written (spec silent); getQueueBoard sets no Cache-Control.

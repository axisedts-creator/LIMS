# T-Q1 impl
- Files: repository/queue.repo.ts, service/queue.service.ts, handlers/queue.handlers.ts (new); handlers/index.ts (wire 8 ops, replaces placeholders).
- Result: 105/105 pass after tester fix per T-Q1-ruling (harness defect; no impl change needed).
- [CONV] assertRole(permission, centreId) before any query; PUT asserts again with the stored row's centre; RLS-hidden row -> 404 before If-Match compare (409 only for visible rows).
- [CONV] If-Match parsed as in settings.service; PUT = full replacement; centre_id immutable (mismatch -> 400 /centre_id); unknown body keys -> 400.
- [CONV] pg 23505 -> 400 common.validation_failed on /code (queue) or /display_name (counter); 42501/23503 -> 404; other pg errors -> common.internal.
- Open: board_version not bumped on PUT (spec silent; T-Q2/T-Q5 may need it); create checks core.collection_centres via SELECT (no spec'd repo for it).
- tsc: 0 errors under modules/engagement (pre-existing errors elsewhere). Not run: lint, real-Postgres integration.

# T-Q1 impl
- Files: repository/queue.repo.ts, service/queue.service.ts, handlers/queue.handlers.ts (new); handlers/index.ts (wire 8 ops, replaces placeholders).
- Review round: sub-codes -> registry `common.field_invalid` (dup /code|/display_name, immutable /centre_id); list LIMIT 200 (maxItems); create 42501/23503 -> 400 /centre_id (no 404 on create; update keeps 404).
- Result: engagement suite 599 pass / 2 skipped; tsc 0 errors under modules/engagement.
- [CONV] assertRole(permission, centreId) before any query; PUT asserts again with the stored row's centre; RLS-hidden row -> 404 before If-Match compare (409 only for visible rows).
- [CONV] If-Match parsed as in settings.service; PUT = full replacement; centre_id immutable (mismatch -> 400 /centre_id); unknown body keys -> 400.
- Open: board_version not bumped on PUT (spec silent; T-Q2/T-Q5 may need it); create checks core.collection_centres via SELECT (no spec'd repo for it).
- Not run: lint, real-Postgres integration (RLS).

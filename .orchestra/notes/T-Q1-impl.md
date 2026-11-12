# T-Q1 impl
- Files: repository/queue.repo.ts, service/queue.service.ts, handlers/queue.handlers.ts (new); handlers/index.ts (wire 8 ops, replaces placeholders).
- Result: 104/105 pass; 1 disputed (test never records the INSERT) -> `.orchestra/notes/T-Q1-dispute.md`.
- [CONV] assertRole(permission, centreId) before any query; PUT asserts again with the stored row's centre; RLS-hidden row -> 404 before If-Match compare (409 only for visible rows).
- [CONV] If-Match parsed as in settings.service; PUT = full replacement; centre_id immutable (mismatch -> 400 /centre_id); unknown body keys -> 400.
- [CONV] pg 23505 -> 400 common.validation_failed on /code (queue) or /display_name (counter); 42501/23503 -> 404; other pg errors -> common.internal.
- Open: board_version not bumped on PUT (spec silent; T-Q2/T-Q5 may need it); create checks core.collection_centres via SELECT (no spec'd repo for it).
- Not run: tsc clean-check (pre-existing TS2835/TS5097 errors in contracts/ + shared-ts drown output), lint, real-Postgres integration.

APPROVE

Re-review after 7ff7c490. Both open items are fixed in .orchestra/cr/T-E2E1.nonblocking.md:
1. Line 9: the `/events` body now carries `aggregate_seq: integer`, and the route builds envelope.aggregate {type, id, seq}. That matches e2e.ts:76, so the stale-seq check at e2e.ts:126-129 now has a real meaning.
2. Line 8: the `/scenarios` 201 response now includes `specimen_type_code`. That matches e2e.ts:121 and the §3.7 required field.

Static suite: 11/11 pass (`node --test tests/e2e/engagement-journey.static.test.mjs`). nightly.yml runs the e2e file (done_when). Names, routes, permissions and error codes are unchanged from the earlier review. There is no DDL, so RLS does not apply. There are no secrets and no PHI in logs, paths are owned, and data is synthetic.
Non-blocking: the nightly.yml comment cites `.orchestra/cr/T-E2E1.md`, but the file is named `T-E2E1.nonblocking.md`.

CHANGES

Re-review after d6d84eda/0567e389. Previous items 1, 3, 4 are fixed in tests/e2e/engagement-journey.e2e.ts:121-135 and :112-113. The §3.7/§3.17 payloads now match the required fields, and the enums (`report_kind: final`, `release_basis: paid_in_full`) match 03 lines 774/778. The static suite passes 11/11 (`node --test tests/e2e/engagement-journey.static.test.mjs`). The CR the test is written against was not updated, though (last touched 44c09dfe, before the review):

1. .orchestra/cr/T-E2E1.nonblocking.md:9 — the `/events` body is still `{event_type, payload}`. The test now sends `aggregate_seq` (e2e.ts:76). A test-support route built to this CR will ignore it, and the stale-seq check at e2e.ts:126-129 then proves nothing. Fix: change line 9 to `POST /events {event_type: ..., aggregate_seq: integer, payload} -> 202  (route builds envelope.aggregate {type, id, seq=aggregate_seq} per 03 envelope; publishes onto the bus as C5/C6/C4 would)`.
2. .orchestra/cr/T-E2E1.nonblocking.md:8 — the `/scenarios` 201 response has no `specimen_type_code`. e2e.ts:121 reads `j.specimen_type_code`, which is therefore undefined, so `lab.specimen.status_changed.v1` fails the §3.7 required check. Fix: add `specimen_type_code` to the response list after `specimen_id`.

Still OK: names, routes, permissions and error codes are as in the previous review. There is no DDL, so RLS does not apply. There are no secrets and no PHI in logs, paths are owned, data is synthetic, and nightly.yml is unchanged.

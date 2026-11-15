APPROVE

Scope: `git diff 585e5eab2..HEAD` = commit f2ecda69c (debugger round 7): one line in services/api/src/modules/homecollection/collection.service.ts:79 (`payments: []` in the H9 apply event payload) + HC-T13-debug.md note.

- Names/spec: contracts/events/homecollection.collection.synced.v1.schema.json lists `payments` in `required`; 03-IC §3.23 (line 995) states the trigger covers a dispatcher apply of a held collection "(payments empty)" (CR-C17-006). Fix matches spec verbatim; `collections` non-empty, so the "not both empty" constraint holds.
- Tests: review.test.ts:45 already asserts `p.payments ?? []` equals `[]`; US-09-1 emits-once assertions (lines 27, 34, 54, 102, 112, 254) unchanged. Debugger reports HC-T13.pg.sh 58/58 pass (not re-run by reviewer).
- Tenant isolation, permissions, error codes, idempotency, logs: untouched by this diff; no PHI logging, no secrets, only owned path edited, nothing invented.

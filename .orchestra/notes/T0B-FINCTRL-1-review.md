APPROVE
Scope 44f6c132a..HEAD: one test-file edit + notes/logs. No handler, service, migration, contract or probe change.
- masters.test.ts:107 adds `account_group_id: a.groupId` to the first listAccountParticulars query, exactly as LD-390 ruled; no assertion removed or loosened; second call (limit 1) and cursor/invalid_cursor checks untouched. Owned path (billing __tests__).
- Verify: run1 753/754 (only failure billing unit/boot.test.ts 63.7 s timeout, the known host-load flake from LD-390, no FINCTRL cause); run2, run3, run4 = 754/754, three green in a row.
- No PHI or secrets added; logs contain only synthetic request ids and error codes.
- Prior-round review items (names, RLS, permissions, error codes) unchanged by this diff.
Non-blocking: impl note says the whole-suite FINCTRL_SUITE run was not done in this session; the lead decides if that is required.

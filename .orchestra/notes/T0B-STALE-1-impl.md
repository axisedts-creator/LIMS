# T0B-STALE-1 impl (writer)
- db/tests/grants/T0B-08_grants.test.sql: generic class-A "has no UPDATE" check skips reporting.provider_events; new check asserts UPDATE = true for lims_app/lims_api/lims_worker (20261116020000, LD-257).
- db/tests/engagement/T0B-13.C16_schema.test.sql: trigger list + number_counters__patient_no_decrease (8); function list + guard_counter_decrease (20261116030000, LD-257).
- db/tests/engagement/T-SEC1_table_probes.test.sql check 14: the 3 RESTRICTIVE number_counters__*__nonstaff_keys policies excluded by name AND permissive = 'RESTRICTIVE' (20261116030000, LD-257).
- [CONV] each change has a `--` comment naming LD-257 + migration; no check deleted; no policy/grant/migration change. Descriptive header comments (C16 "7 spec triggers") left as is.
- Ran: node --test tests/db/T0B-STALE-1.static.test.mjs 4/4 pass. Related suites (T0B-08.suites, T0B-13.C16.engagement, T0B-DBFIX-1) 2 fails, both not from this task: AC-0B-1.3 scan hits services/api/test-sweep/run.ts (T0B-SWEEP-1); engagement migration ordering (20261116030000). pgTAP not run.
- For the lead (NOT in this task, no 'have' line available, pgTAP not run in lane): partners.manifest_lines DELETE grant checks 135/308/481; C16 checks 96/137/139; other-suite failures per LD-263.

Title: CR-C0-T0B-DBFIX-1-003: db/tests/grants and db/tests/immutability failures
From chunk: C0 (lane C0-0B, T0B-DBFIX-1)            To owner: C0-0B (lead triage)
Type: bug
Blocking? no (LD-230 NOT IN SCOPE list; the assertion was not edited)
Problem: the suites under db/tests/grants and db/tests/immutability fail on the first real-database run (LD-230 not in scope).
Proposed change (exact): route to T0B-REVIEW-1 / T0B-HARDEN-1.
Backward compatible? yes (tests only)
Tenant/security impact: none from this CR; the lead decides whether the assertion or the schema is wrong (no RLS change made here).
IRD/regulatory impact: none
Alternatives considered: editing the assertion in T0B-DBFIX-1 (forbidden by LD-230 RULES).
Tests that will prove it: founder rerun of db/tests/grants/*.test.sql and db/tests/immutability/*.test.sql.

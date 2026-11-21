Title: CR-C0-T0B-DBFIX-1-004: T0B-10.C2_policies tests 63 and 72
From chunk: C0 (lane C0-0B, T0B-DBFIX-1)            To owner: C0-0B (lead triage)
Type: bug
Blocking? no (LD-230 NOT IN SCOPE list; the assertion was not edited)
Problem: db/tests/identity/T0B-10.C2_policies.test.sql tests 63 and 72 fail on the first real-database run (LD-230 not in scope).
Proposed change (exact): route to T0B-REVIEW-1 / T0B-HARDEN-1.
Backward compatible? yes (tests only)
Tenant/security impact: none from this CR; the lead decides whether the assertion or the schema is wrong (no RLS change made here).
IRD/regulatory impact: none
Alternatives considered: editing the assertion in T0B-DBFIX-1 (forbidden by LD-230 RULES).
Tests that will prove it: founder rerun of db/tests/identity/T0B-10.C2_policies.test.sql.

Title: CR-C0-T0B-DBFIX-1-001: core.membership_centres cross-tenant insert returns 23514 before RLS (T0B-03_isolation test 39)
From chunk: C0 (lane C0-0B, T0B-DBFIX-1)            To owner: C0-0B (lead triage)
Type: bug
Blocking? no (LD-230 NOT IN SCOPE list; the assertion was not edited)
Problem: db/tests/core/T0B-03_isolation.test.sql test 39 expects 42501; the BEFORE INSERT trigger membership_centres__scope_user_only raises 23514 first (run-suites-1.log, LD-230).
Proposed change (exact): route to T0B-REVIEW-1 / T0B-HARDEN-1: either accept 23514 as the refusal code (as LD-21 does for the generated probes) or reorder the guard; decision for the lead.
Backward compatible? yes (tests only)
Tenant/security impact: none from this CR; the lead decides whether the assertion or the schema is wrong (no RLS change made here).
IRD/regulatory impact: none
Alternatives considered: editing the assertion in T0B-DBFIX-1 (forbidden by LD-230 RULES).
Tests that will prove it: founder rerun of db/tests/core/T0B-03_isolation.test.sql.

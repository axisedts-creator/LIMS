Title: CR-C0-T0B-DBFIX-1-005: T0B-12_storage bucket-existence assertions cannot pass on the storage stub
From chunk: C0 (lane C0-0B, T0B-DBFIX-1)            To owner: C0-0B (lead triage)
Type: bug
Blocking? no (LD-230 NOT IN SCOPE list; the assertion was not edited)
Problem: LD-230 (8) stub creates storage.buckets/objects without rows (buckets come from the Storage API, LD-54), so T0B-12_storage.test.sql lines 30 (every 08 §4.8 bucket exists) and 50 (11 buckets x 2 tenants seeded) still fail in run-suites.sh; storage.objects in the stub has no FK to buckets and no Supabase policies, so the RLS probes there prove only the stub.
Proposed change (exact): lead decides: run T0B-12_storage only against a Supabase stack with provisioned buckets (skip it in run-suites.sh by an explicit list), or provision buckets in the stub through a test-only step.
Backward compatible? yes (tests only)
Tenant/security impact: none from this CR; the lead decides whether the assertion or the schema is wrong (no RLS change made here).
IRD/regulatory impact: none
Alternatives considered: editing the assertion in T0B-DBFIX-1 (forbidden by LD-230 RULES).
Tests that will prove it: founder rerun of db/tests/storage/T0B-12_storage.test.sql.

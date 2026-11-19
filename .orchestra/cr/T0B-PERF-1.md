Title: CR-C0-PERF-1: add LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS and lower LIMS_CORE_DB_POOL_MAX default to 10
From chunk: C0 (task T0B-PERF-1)            To owner: C0-0B (doc owner for C0 02-TRD; C1 consumer)
Type: shared-lib (environment contract)
Blocking? no (code ships with these values under LD-310; this CR aligns the spec text)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  T0B-PERF-1 done_when (4): "statement timeout (5 s for reads, 15 s for writes) and a pool size that fits the Supabase pooler limit are set from environment with safe defaults". C0 02-TRD §env (lines 943-944) has only one `LIMS_CORE_STATEMENT_TIMEOUT_MS` (5000) and `LIMS_CORE_DB_POOL_MAX` default `20`. A separate write timeout has no env name, and 20 per process exceeds the Supabase pooler budget for small tiers.
Proposed change (exact):
  C0 02-TRD §env table:
  - add row: `LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS` | `15000` [CONV] | statement timeout for read-write transactions; `LIMS_CORE_STATEMENT_TIMEOUT_MS` stays the read-only timeout (5000)
  - change row `LIMS_CORE_DB_POOL_MAX`: default `20` -> `10`, valid range 1..60 (values above 60 refused at boot)
  C1 02-TRD:558 pgbouncer comment: "≥ 2 API replicas × LIMS_CORE_DB_POOL_MAX 20 (C0)" -> "× LIMS_CORE_DB_POOL_MAX 10 (C0)"; `default_pool_size = 40` still covers it (C1 may lower it, not required).
Backward compatible? yes. New variable is optional with a default; an operator who sets LIMS_CORE_DB_POOL_MAX=20 keeps 20.
Tenant/security impact: none (no RLS, no PHI, no public surface). Timeouts bound runaway queries (availability).
IRD/regulatory impact: none.
Alternatives considered: one shared timeout (rejected: done_when asks 5 s reads / 15 s writes); keep default 20 (rejected: exceeds small Supabase pooler tiers with 2+ processes).
Tests that will prove it: services/api config + tx tests (read vs write timeout, pool bound), env-doc test (docs/runbooks/environment.md lists both names). Code as of commit 6cb4be5ee, kept as is while this CR is pending (LD-310).

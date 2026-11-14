# C3 plan tasks skipped (not in task JSON)

None. The plan (06-IMPLEMENTATION-PLAN.md) marks no task as blocked/deferred (no B4 reference); all 41 rows T-01…T-38 (incl. T-28a/b, T-29a/b) are in the JSON.

Gated by missing C0/CR preconditions, kept in `depends` (not skipped):
- T-11 — CR-C3-002 (`@lims/shared-ts/formula`).
- T-20 — CR-C2-011 (multipart + `ctx.files.scan`; absorbs CR-C3-005).
- T-21 / T-24 — `@lims/shared-ts/spreadsheet` (`neutraliseFormula`, `restoreNeutralised`).
- T-26 — C0 `per_tenant` cron fan-out (P-6).
- T-29 — CR-C3-001. T-31 — CR-C3-006 (`@lims/ui`).
- T-25 — CR-C3-007 starter workbooks (fallback: hand-built minimal fixture).

Notes: `verify` = `pnpm -s verify` for every task (docs-only T-38 too). T-27 depends on T-28a (plan CONV). `depends` entries not of form `T-nn` are external preconditions. Wildcard ACs expanded from 01-PRD.md ids; non-AC refs (PRD §7 metric, 02-TRD §7.6a, 05-DoD §3.8) kept verbatim.

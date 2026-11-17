APPROVE

Re-review after 558d457 ([writer] C6-T04 review fixes). Prior finding 1 (per-specimen seq, TRD §8.2) resolved as instructed: `.orchestra/cr/C6-T04.md` filed as CR-C6-022 (next free id after CR-C6-021, unique; template fields present, Blocking? no, options A/B, tests listed), and reports.service.ts:181 comment now cites CR-C6-022 instead of the ponytail note. Code unchanged otherwise.

Earlier checks still hold (no defect): names verbatim vs 02-TRD §4.1/§8.2, 03-IC §3.12 and the C6 migration; upsert keys match DDL uniques; every statement binds tenant_id and casts `::uuid[]`; envelope tenant ≠ job tenant refused; assemble job key/run_at/max_attempts per §9; no logging/PHI, no secrets; only C6-owned paths; no new tables (RLS n/a).
Tests: ran `.orchestra/notes/C6-T04-verify.cmd` equivalent — 4 files, 91/91 pass.
Non-blocking notes (carried over): (a) `shellFromSummary` passes optional `OrderSummary.registeredAt` (03-IC:1335) into NOT NULL `reports.registered_at` — retry loop on a pre-registered order. (b) Not verified on real PG/RLS (fake DB only); worker not type-checked (no tsconfig). (c) Multi-specimen hint stays wrong until CR-C6-022 ruled.

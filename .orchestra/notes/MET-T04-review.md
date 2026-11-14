APPROVE

Scope reviewed: `git diff cf7ed6e2..HEAD` (a67672e0): `services/api/src/modules/instruments/service/hostQuery.service.ts` + impl note. Context also checked: `db/migrations/20261114120000_instruments__add_getein_metis_driver.sql` (from 5d278fef).

- hostQuery.service.ts:41 / :88 match the lead AUTO decision (2026-11-14 12:38, LD-163 cited): `[]` accepted, `<= MAX_BARCODES` and per-barcode 1..40 checks kept, `answerAll([])` returns `[]` before any LabPort/CatalogPort access, `buildHostQueryReply` called with `answers []` on both the fresh and the L1-duplicate path; step-2 capability gate (`gated`) untouched, so generic getein_metis stays inert.
- No regression for truth_h80e: its `extractHostQueryBarcodes` still throws `instruments.message_malformed` on zero barcodes (truth_h80e/hostQuery.ts:14-15), so the relaxed service check never sees `[]` from it. Mindray sketch has no extractor (gated).
- Migration: first statement `SET LOCAL ROLE lims_owner;` (LD-161), one INSERT with the 14 truth_h80e columns, status `generic`, no UPDATE. No RLS change needed (global `g_` table).
- No logging added, no PHI, no secrets, no new names/error codes.
- Ran (repo root): `npx vitest run` hostQuery.service, hostQuery.getein_metis, e2e simulator-agent-api-metis, getein-metis + truth-h80e registry: 5 files, 127 passed, 4 todo, 0 failed.

Not verified by reviewer: fresh-DB migration bootstrap / pgTAP (no Postgres here, same as writer). Housekeeping for lead (not a code defect): `.orchestra/cr/MET-T04.md` is now obsolete; e2e header comment lines 9-10 (tester-owned) still describe the closed "KNOWN GAP".

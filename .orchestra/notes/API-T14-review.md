APPROVE

Reviewed `git diff 3ffb58b..HEAD` (API-T14) against 02-TRD §5.10, §9, §10, §11, §13; 03-APP-FLOW §2.3–2.5; 05-SCHEMA (§5 DEFINERs, tables, mutable-column triggers, §8 items 7/9/10); 03-IC CatalogPort/IdentityPort/TenantSettings; event schema `instruments.agent.health_changed.v1`.

- Names verbatim: task ids, cron schedules, scopes, max attempts (§10); metric names/labels (§13); alert rules match §13 table exactly; bucket `instruments-attachments` (08 R26); column names match 05-SCHEMA; `app.purge_instruments_archive(int)` returns `(table_name, deleted)`; `app.enqueue_job` signature as core fanout.
- Tenant: every per-tenant statement binds `tenant_id = $1` from job claims; payload tenant mismatch refused (`jobTenant`); purge deletes only through the DEFINER; export runs platform-scope via snapshot DEFINER only. No new tables/policies in this task (RLS/FORCE is the DB DDL's, covered by db/tests C7 checks 16/17).
- Idempotency: health event key `<agent_id>:health:<health_version>`, duplicate publish skips writes; `health_version` guard on UPDATE; release configs no-change → no version; consumer through core inbox wrapper, job_key `instruments.refresh:<tenant>`.
- Logs: counts only; no object paths, codes, keys. Signing key file never echoed. No secrets in files.
- Paths: only `services/worker/src/jobs/instruments/*` + own `.orchestra` notes/CR.
- Tests: ran `pnpm exec vitest run --root services/worker src/jobs/instruments/__tests__` → 8 files, 124 passed. Cover AC-13.2–13.6 transitions/events (real core publisher), duplicate delivery, AC-15.5 release half (Ed25519 verify), AC-17.3, AC-20.1/20.2; purge boundaries under FORCE RLS are asserted in db/tests/instruments/T0B-10.C7_behaviour.test.sql (check 17).

Non-blocking observations (no change required for T14):
1. Impl note and `shared.ts:452` comment cite `.orchestra/cr/API-T14.md`; the file is `.orchestra/cr/API-T14.nonblocking.md`.
2. Tasks need the CR (JobContext `ports`/`metrics`) before running in the real worker — already raised.
3. Canonical JSON uses lowercase `\u00xx`; Go/TS golden vector (§5.10) still open — must be pinned when the agent side lands.
4. Purge relies on `ctx.storage.delete` treating an already-missing object as success; otherwise a row whose object was deleted but not marked (rolled-back run) stays unpurged. Confirm with C0 adapter semantics.

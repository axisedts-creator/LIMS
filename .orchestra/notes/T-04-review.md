APPROVE

- Diff 0e4233e..HEAD: code only in `services/api/src/modules/lab/events/publish.ts` (owned) + its `__tests__`; rest are `.orchestra/notes` role files.
- 7 event names and idempotency keys verbatim from 02-TRD §7.1 (lines 376–382); `approved_set_hash` per 03-IC §3.12 (SHA-256 hex, sorted `result_id:version_no`); `value_sha256_prefix16` per §7.1 [CONV].
- Payloads passed through; core schema (additionalProperties false) enforces IC shape; critical value used only in key hash, never in payload/logs. No logging, no secrets, no PHI.
- Tenant from ctx (test :231). No DB/RLS, routes, permissions, rate tier or new error codes in scope for this task.
- Ran: `vitest run src/modules/lab/events/__tests__` = 57/57 pass; `tsc --noEmit` no errors in lab/events.
- Tests cover done_when (all 7 IC examples validate, keys, dedupe), AC-01.1 (:243), AC-05.1 (:261, rollback fixed per T-04-ruling), AC-05.5, AC-16.5.
- Note (not a defect): aggregate seq choice (specimenVersion / resultRowVersion / readinessSeq) is [CONV], spec silent; real PG insert not proven here.

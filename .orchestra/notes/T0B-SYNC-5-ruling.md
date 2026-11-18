IMPLEMENTATION_WRONG — load.live.test.ts:50 (`rejected` = 0 on a clean load) is right; engine.ts:218-233 must not turn SQLSTATE 40001/40P01 into a per-op `rejected common.internal`, it must rethrow so the whole request tx is retried (02-TRD §6.4).
1. Dispute 2 (writer, 2026-11-19 01:00 NPT): 305/351 rejected ops in the load run; writer suspects 40P01 between the patient row and the gap-free counter row.
2. spec/chunks/C0-foundation-contracts/02-TRD.md:604: SQLSTATE 40001/40P01 means the WHOLE request transaction is retried up to LIMS_CORE_TX_RETRY_MAX (3) times (:945); after the retries it ends `503 common.dependency_unavailable` (:617). 03-APP-FLOW.md:287 (E-5) says the same.
3. engine.ts:231 `codeOf(e)` maps a deadlock caught at the op SAVEPOINT to `common.internal`, marks a valid op `rejected` and commits the batch. The core retry (core/db/tx.ts:57 RETRYABLE, pipeline/index.ts:254) never fires. That breaks §6.4, and brief done_when (1) "no lost operation". It is a defect in existing code, so done_when (6) does not shield it: (6) forbids new behaviour, not making the code follow the TRD.
4. A per-op retry inside the same tx is NOT a fix. The counter lock taken by an earlier receipt op in the batch sits outside the op SAVEPOINT and stays held, so the same cycle comes back. Only the whole-request retry of §6.4 breaks it.
5. WRITER: in the engine catch (engine.ts:231), rethrow any error whose SQLSTATE is 40001 or 40P01 unchanged, before codeOf. Change nothing else in the engine. Do not reorder adapter locks and do not touch the kit adapters.
6. TESTER (harness fidelity only, no assertion changed): helpers2.ts fire2 (:127-139) opens a raw pool client and skips the production retry. Route the pushSyncBatch path of fire2 through the same 40001/40P01 whole-request retry as core (createDb requestTx, retryMax 3). Do not loosen load.live.test.ts:40/:50 or any other assertion.
7. FIRST, before coding, the writer runs the probe from the dispute: rejected rows' error_code in core.sync_operation, plus "deadlock detected" in the PG log. If the rejections are NOT 40P01/40001, this ruling does not apply; write a new dispute with the real codes.
8. Item 2 (retention.live.test.ts, CR-C0-T0B-SYNC-5-001) is unchanged: founder-reserved, escalated per LD-397; do not touch it.

---
## PRIOR RULING (dispute 1, 2026-11-19 00:43 NPT) — applied in c56701623; kept for the record

TESTS_WRONG — static.test.ts:118 regex `/\bsync\.[a-z_]+\b/g` truncates dotted permission codes; change it to `/\bsync\.[a-z_]+(?:\.[a-z_]+)*\b/g`, nothing else.
1. Permission codes `sync.use`, `sync.device.manage`, `sync.conflict.resolve` are binding names from LD-322 (task brief lead decisions; grep of spec/program and spec/chunks/C0-foundation-contracts finds no conflicting definition).
2. Brief done_when (5) requires the runbook to cover conflict inbox and device wipe/revoke; static.test.ts:82 and :87 correctly pin those full permission codes in the runbook.
3. static.test.ts:118 then matches only `sync.conflict` / `sync.device` inside them; the exclusion list holds full codes, so the truncated strings reach :122 and fail (`sync.device: expected false to be true`). The test contradicts itself; no implementation can satisfy :82/:87 and :118-122 together.
4. Widened regex keeps the intent of :116 (every sync.* error code in the runbook is in the closed list) without loosening it: single-segment error codes match as before; full permission codes are now excluded by the existing list.
5. Do not change :82, :87, the exclusion list, the :121 requestLevel set, or any other assertion.
6. Item 2 (retention.live.test.ts, CR-C0-T0B-SYNC-5-001 DELETE policy/grant) is not ruled here: founder-reserved (data deletion, LD-310/LD-322), escalated per LD-397; leave test, migration, policies and pgTAP pins untouched.

## LEAD ITEM LD-397 FOR THE TESTER (written by the lead, 2026-11-19 00:50 NPT)

Two separate items were in the writer dispute. Only item 1 is yours to fix.

### Item 1 — fix this (static.test.ts)

The writer dispute is correct: in `static.test.ts`, the test "every sync.* error code the runbook mentions is a registered code" (around lines 116-122) uses a regex that only captures the first two dot-segments of a sync error code. Lines 82/87 of the same file require the runbook text to contain `sync.conflict.resolve` and `sync.device.manage`, but the regex `/\bsync\.[a-z_]+\b/g` matches only `sync.conflict` / `sync.device` out of those strings, so the exclusion/registered-code comparison is checking a truncated code against the full registry and can never pass.

Fix: widen the regex to capture the full dotted code, e.g.:
```
/\bsync\.[a-z_]+(?:\.[a-z_]+)*\b/g
```
Apply this single regex change at the match site in static.test.ts (the one the writer's dispute points at, lines 116-122). Do not change lines 82/87, do not change the exclusion list, do not change any other assertion in this file.

### Item 2 — NOT yours to fix, do not touch

`retention.live.test.ts` fails because the DELETE grant/RLS policy it needs (CR-C0-T0B-SYNC-5-001) is a founder-reserved decision (data deletion + a new DB permission grant, outside blanket authority LD-310) and has been escalated directly to the founder — see the existing `T0B-SYNC-5-lead-20261119001953.md` escalate note in this same folder, and LD-397 in lead-decisions.md. The writer already did the safe thing on its own: the migration file exists but was deliberately removed from `db/migrations` so the existing pgTAP suite (T0C-SYNC-2) stays green until this is approved.

Do NOT: skip, loosen, or delete retention.live.test.ts; write or re-add the migration; touch db/policies/core.sql, db/meta/tables.yaml, or any GRANT/POLICY statement; touch the pgTAP pins in `db/tests/core/T0C-SYNC-2_sync_operations_conflicts.test.sql` (lines 87/91). These all require the founder's decision first, then an explicit arbiter/lead supersession ruling (precedent LD-358) before anyone edits them.

WRITER and DEBUGGER: after item 1 is fixed, if retention.live.test.ts is the ONLY remaining failure, that is the expected, already-flagged wait state — do not dispute it again and do not run more debugger rounds on it. Report/leave as blocked on that one item and move to other work; this unblocks once the founder answers and a follow-up LD ruling lands.

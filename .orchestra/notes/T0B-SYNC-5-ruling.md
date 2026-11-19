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

----
LEAD RULING, LD-407: founder declined CR-C0-T0B-SYNC-5-001 (DELETE policy / GRANT DELETE to
lims_worker on the 5 core.sync_* tables, 180 day purge). Verbatim in chat (08:04 NPT): "sync 5 no".

This is final: no DELETE policy, no GRANT DELETE, on any of core.sync_operation, core.sync_conflict,
core.sync_signoff_outcome, core.sync_print_marker, core.sync_alert. The existing never deleted
contract (db/tests/core/T0C-SYNC-2_sync_operations_conflicts.test.sql lines 87/91, db/meta/tables.yaml)
stands exactly as pinned -- not superseded, not touched.

The RETENTION sub-requirement of this task's done_when (item 3) is dropped entirely as a result.
Everything else in done_when -- LOAD, CHAOS, OBSERVABILITY, RUNBOOK (minus its retention section) --
is unaffected and still applies in full.

EDITS:
1. core/sync/retention.ts: remove the DELETE logic so it issues no DELETE statement on any of the 5
   tables. If nothing else in the module has a purpose once deletion is removed, delete the module
   and its call sites rather than leaving dead code behind.
2. Worker cron.ts / tasklist.ts: remove the core.sync_retention daily cron registration. There is no
   job to run.
3. Delete retention.live.test.ts in full (the 13 failing tests) -- there is no retention feature left
   to test.
4. Do NOT touch registry.static.test.ts:71 or sync2.registry.static.test.ts:95 ("rows are never
   deleted: no DELETE ... in sync code") or the pgTAP pins named above. They are correct as written
   and were never in question -- this ruling confirms them, it does not supersede them.
5. docs/ops/OFFLINE-SYNC.md: remove the retention/purge section. Replace it with one short line: the
   sync ledger tables are retained indefinitely, no automatic deletion (LD-407, founder, 2026-11-19).
6. core/sync/metrics.ts and the 3 observability gauges (backlog age, conflict inbox size, recall
   count, etc.) stay as built -- unrelated to deletion, done_when (4) OBSERVABILITY still applies.

Not ruled on here, stay open on their own track (neither is money or data, the lane/arbiter handles
normally): the load.live.test.ts:50 deadlock dispute (40P01/40001, TESTS_WRONG vs. engine retry) and
the static.test.ts runbook-regex dispute (sync.device / sync.conflict exclusion-list bug).

Reset: C0-0H T0B-SYNC-5 to changes.

----
LEAD RULING, LD-412: load.live.test.ts deadlock (40P01) is a test-kit fixture bug, not a production
defect. Writer dispute 3 and debugger dispute 4 independently converge: kit.ts's synthetic adapters
take locks in inconsistent order across operation types (registration: patient/order then counter;
plain receipt: counter directly), creating a genuine lock cycle under 200 concurrent devices that
recurs through every retry. The engine's 40P01/40001 rethrow and the harness's 3x whole-request
retry (02-TRD 6.4) are both correct as designed; a real production fix would need a tenant-wide
batch lock, which serialises sync and is exactly what done_when (6) forbids.

RULING: TESTS WRONG, fix is in kit.ts, not production code, not a looser assertion. Reorder the
synthetic adapters so every one of them takes the gap-free counter row before the
patient/order/state inserts (or gives registration a sorted-key pre-lock across everything it will
touch) -- tester's choice of mechanics, as long as every adapter locks in the SAME order.
load.live.test.ts's assertion stays exactly as written.

Reset: C0-0H T0B-SYNC-5 to changes.

----
LEAD ITEM, LD-415 (2026-11-19):

The rerun after LD-412 no longer hangs (4 of 5 test files pass), but load.live.test.ts still fails:
23 operations come back as common.dependency_unavailable. Per helpers2.ts fire2, that only happens
when SQLSTATE 40001 or 40P01 fires on every one of RETRY_MAX (3) attempts. 40P01 is a true
deadlock, the thing LD-412 targeted. 40001 is a serialization failure under SERIALIZABLE isolation,
which Postgres can raise even with perfectly consistent lock order, purely from concurrent write
conflicts, and a lock-ordering fix does not address it.

Debugger: capture which SQLSTATE is actually firing on these 23 (log it per attempt if the harness
does not already) before changing anything further.

If it is 40P01: LD-412 reordering is still incomplete somewhere in kit.ts across the eight adapter
types; find the remaining adapter(s) with inconsistent lock order and fix under LD-412 own terms.

If it is 40001: stop there. Do not touch LIMS_CORE_TX_RETRY_MAX, backoff, or jitter in
core/db/tx.ts yourself. Write up what you found and the lead will rule on raising the retry budget,
adding backoff, or another approach, since that changes production resilience behavior, not just
the test kit.

Either way, load.live.test.ts assertion stays exactly as LD-412 already said: no change to it or to
done_when from this item.

Reset applied: changes.

----
LEAD ITEM, LD-417 (2026-11-19).

LD-415 question is answered: debugger round 8 confirms neither 40001 nor 40P01 fires anymore.
LD-412 fix holds; this is a different, later-appearing problem, not a residual deadlock.

Cause, per the writer own diagnosis (agrees with the debugger): LD-412 told every kit adapter to
take the gap-free counter row before its other inserts, to keep one global lock order. Only one of
the eight synthetic adapter types, billing.record_receipt, actually calls nextNo on that counter;
the other seven (registration, collection, accession, result.enter, result.verify,
report.print_marker, daily_cash.close) never touch it in production or in the real adapters they
stand in for. Making all eight take that lock anyway, purely for ordering, now serialises all 400
load-test batches on one row, and p95 batch time climbs past the 30000 ms bound (34.7s, 42.0s,
47.4s, 53.3s across repeated runs).

RULING: TESTS_WRONG, kit.ts only, same discipline as LD-412 (no done_when change, no assertion
loosened, no production code touched). Narrow which adapters take the counter lock to exactly the
one that needs it: only the billing.record_receipt adapter calls nextNo and must still take that
lock before its own patient/order/state work (LD-412 ordering requirement stands for this
adapter). The other seven adapters stop taking the counter lock at all, since nothing they do
needs it and production own code never has them touch it either. This removes the artificial
contention LD-412 incidentally introduced into unrelated adapters, rather than just raising the
bound to tolerate it (the bound stays 30000 ms; a wider bound would hide a fidelity problem in the
test kit instead of fixing it).

If p95 is still over bound after this change with 40001/40P01 still absent, that is a new
finding (real contention on the counter from receipt-issuing batches alone) and needs a fresh
look, not a further kit tweak on guesswork.

Reset: C0-0H T0B-SYNC-5 to changes.

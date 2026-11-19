# T0B-SYNC-5 dispute (writer, 2026-11-19 11:07 NPT) — after LD-417 kit change

- No T0B-SYNC-5-review.md exists; the newest ruling (LD-417) touches kit.ts only, and the tester has applied it (kit.ts:75-83). The writer has no implementation item.
- Rerun of tests/core/T0B-SYNC-5.pg.sh (11:02, 258 s): 53/54 pass. Only load.live.test.ts:40 `expect(failures).toEqual([])` fails, with roughly 40 ops `common.dependency_unavailable`. In fire2 that code means 40001 or 40P01 fired on all 3 whole-request attempts. The p95 bound was not reached, because :40 fails first.
- Likely cause (test kit, inferred from the code, not proven). LD-417 puts back the LD-412 cycle:
  1. A billing.record_receipt op holds the counter row FOR UPDATE until the end of the request tx (kit.ts:77-83).
  2. In the same batch, a later registration op then inserts s5_patient(patient_key) from the shared pool of 300 (kit.ts:88).
  3. Another batch has already inserted that patient key, so it holds the unique-index lock, and its own later receipt op now waits on the counter: deadlock (40P01).
  4. The same cycle also forms on patient key against patient key and on s5_order / s5_state keys, because ops in a batch take keys in batch order, not sorted order.
- LD-417 said: "if still failing with 40001/40P01 absent ... fresh look". Here 40001/40P01 are back, so neither LD-412 (every adapter locks the counter, which breaks p95) nor LD-417 (only receipt locks it, which deadlocks) satisfies both :40 and :82.
- Possible kit fixes (tester or lead choice, no production change):
  - (a) Pre-lock, at the start of each batch, the sorted set of every key the batch will touch (counter, patients, orders, states). This is the "sorted-key pre-lock" LD-412 already allowed.
  - (b) Take the counter lock only inside nextNo, as the last write of the request (defer receipt numbering to the end of the batch).
- SQLSTATE per attempt is not logged by the harness (helpers2.ts has no 40001/40P01 log), so 40P01 vs 40001 is still unconfirmed. Per LD-415 the tester or debugger should add a log line before anyone rules.
- Writer stops here. No implementation file changed; no test edited.

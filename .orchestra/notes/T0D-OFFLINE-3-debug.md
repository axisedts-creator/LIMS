# T0D-OFFLINE-3 debug
Cause: no implementation defect. Only failure was offline1.engine "main thread stays free" (73 ms vs 50 ms cap), a wall-clock event-loop test hit by CPU load (verify run took 128 s; reruns take 44 s).
Evidence: OFFLINE-3 touched outbox.ts/engine.ts only by 1 optional field + 1 WIRE_KEYS entry (no added CPU work). Test alone: pass. Full offline1 config rerun: 5 files, 82/82 pass.
Fix: none; no code or test changed. Rerun verify.cmd; if flake recurs under load, lead should decide on running offline1 serially or a tester-owned threshold change (not mine to edit).

## Round 2
Cause: same single failure (156 ms vs 50 ms cap) in a 170 s verify run; wall-clock event-loop test starved by CPU load. Not an implementation defect.
Evidence: test alone passes (2.2 s); OFFLINE-3 added no CPU work to the outbox/engine hot path; other 81 offline1 tests pass.
Fix: none; code and tests unchanged. Lead: run offline1 config alone/serially, or tester widens the threshold. Not mine to edit.

## Round 3
Cause: same single failure (106 ms in verify; 62 ms when engine file runs alone) in wall-clock "main thread stays free" test; passes in isolation (-t "stays free"). Not an implementation defect.
Evidence: OFFLINE-3 diff in engine.ts/outbox.ts = 1 WIRE_KEYS entry + 1 optional field + `input.op_id ?? nextId()`; no added CPU work. Other 81 offline1 tests pass.
Fix: none; code and tests unchanged. Needs lead: run offline1 config serially/alone in verify.cmd, or tester widens the 50 ms cap. Not mine to edit.

## Round 4 (LD-391)
Cause: verify (21:15) fails in rs-c4.static.test.ts (guard vs rs-c4.baseline.json): drift from already-merged billing accounting UI (accounts/expenses routes, ~160 billing.* permission codes, accounts/expenses server+actions logic files, server_imports, /v1/catalog/tests literal). OFFLINE-3 touches no route or permission file. Not an implementation defect.
Fix: none; LD-391 orders no writer/debugger code change. Tester allow-list covers only 8 routes + 7 codes and under-counts the drift (tester-ld391.md). Needs a new lead ruling naming the rest. Do NOT regenerate rs-c4.baseline.json.

## Round 5 (LD-391, verify 21:22)
Cause: still only rs-c4.static.test.ts failing (6 tests/3 files in the log tail: billing_app permissions + server_imports accounts.server/expenses.server vs rs-c4.baseline.json). Drift from already-merged billing accounting UI; OFFLINE-3 touches no route/permission/server-import file. Not an implementation defect.
Fix: none, as LD-391 orders (writer/debugger no code change; baseline json not regenerated). Unchanged blocker from round 4: tester allow-list (8 routes + 7 codes) under-counts the drift; needs a new lead ruling naming logic_files, ~152 permission codes, 2 server_imports and the /v1/catalog/tests literal.

## Round 6 (LD-391, verify 21:28)
Cause: unchanged. rs-c4.static.test.ts only (permissions ~150 billing.account*/cash_transfer/expense codes, server_imports accounts.server/expenses.server) vs rs-c4.baseline.json; drift from already-merged billing accounting UI. OFFLINE-3 touches no route/permission/server-import file. Not an implementation defect.
Fix: none (LD-391: no writer/debugger code change; baseline not regenerated). Blocker: LD310_ALLOW (tester-owned) under-counts; needs a new lead ruling widening it (permissions, logic_files, 2 server_imports, /v1/catalog/tests literal).

## Round 7 (verify 00:14; rs-c4 rerun 00:16: same 6 fail / 31 pass)
Cause: no OFFLINE-3 defect. Pure rs-c4 guard drift from merged work: static same-bytes +4 billing/server files, route /v1/catalog/tests, billing server_imports +4, billing_app server_symbols +19, register test "no /draft/i button" vs REGSCREEN-2 Save as draft/Drafts (RegistrationForm.tsx:891-892), Daily cash snapshot vs UIDASH.
Fix: none; tests are tester-owned, LD-393 says escalate. Wrote T0D-OFFLINE-3-dispute.md with exact strings. Lead must widen LD310_ALLOW and re-record snapshot; never regenerate baseline.

## Round 8 (verify 00:29: 4 fail / 33 pass, rs-c4.static + rs-c4.screens only)
Cause: no OFFLINE-3 defect. rs-c4 guard drift from merged work: static same-bytes lists billing/nav.manifest.ts, server/{actions,types,write.server}.ts, frontdesk/forms/draft.ts, hooks/useShortcuts.ts; route "/v1/catalog/tests" not in LD310_ALLOW; "Daily cash (open shift)" snapshot lacks UIDASH stat row + chart. None of these files is in the branch diff vs main.
Fix: none; tests are tester-owned and the baseline json must not be regenerated. Dispute (…-dispute-202611190019.md) still stands; lead must widen LD310_ALLOW (logic_files, routes) and re-record the snapshot.

## Round 9 (verify 00:36: 4 fail / 33 pass, rs-c4.static + rs-c4.screens only)
Cause: no OFFLINE-3 defect. Same rs-c4 guard drift as round 8: same-bytes list (billing nav.manifest/server actions,types,write.server, frontdesk draft.ts, useShortcuts.ts), route "/v1/catalog/tests", 45 billing symbols, plus 1 screens snapshot. All from already-merged work; OFFLINE-3 diff touches none of them.
Fix: none; tests are tester-owned, baseline json not regenerated. Dispute T0D-OFFLINE-3-dispute-202611190019.md still stands; lead must widen LD310_ALLOW and re-record the snapshot.

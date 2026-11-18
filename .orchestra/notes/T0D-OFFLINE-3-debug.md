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

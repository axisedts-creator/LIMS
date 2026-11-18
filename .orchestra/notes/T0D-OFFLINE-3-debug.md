# T0D-OFFLINE-3 debug
Cause: no implementation defect. Only failure was offline1.engine "main thread stays free" (73 ms vs 50 ms cap), a wall-clock event-loop test hit by CPU load (verify run took 128 s; reruns take 44 s).
Evidence: OFFLINE-3 touched outbox.ts/engine.ts only by 1 optional field + 1 WIRE_KEYS entry (no added CPU work). Test alone: pass. Full offline1 config rerun: 5 files, 82/82 pass.
Fix: none; no code or test changed. Rerun verify.cmd; if flake recurs under load, lead should decide on running offline1 serially or a tester-owned threshold change (not mine to edit).

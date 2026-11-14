# HC-T11 dispute (debugger): perf.test.ts budgets cannot be met by the implementation
Spec: 02-TRD.md:574-577. A2 unchanged <= 500 ms = 40 x 10 ms balance = 400 ms floor; A2 changed <= 2 s = 50 + 40 x 30 = 1.25 s floor. The budget leaves 100 ms / 750 ms for everything else.
Test: perf.test.ts:28,38,44,50,53-55 time `pull()` = `appTx` (new pool connection, BEGIN, set_config, COMMIT incl. ~40 audit.access_log inserts) + handler, with busy-spin fakes, while 4 other files run in parallel on a loaded host.
Evidence (HC-T11-debug.md): service-side time 0.55-0.72 s unchanged and 1.7-2.3 s changed; the remaining 3.5-4.5 s / ~0.5 s is harness tx + DB commit overhead, not service code. Not proven to be the whole gap.
Ask: either time the handler only (exclude connect/COMMIT), run perf.test.ts in its own non-parallel run, or set the budgets with harness headroom. Implementation unchanged.

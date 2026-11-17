## AG-T17 debug
Cause: TestSessionsRunNeverSleepsForReal failed at 3.23s vs 3s cap, but only in a run where the packages took 89s/241s (machine under heavy load, other lanes). No real sleep exists in impl: fake clock only; only real timers are 5s wedge guards (run.go:400, duplex.go:72) and never fire on the happy path.
Fix: none needed in code. Re-ran the exact verify cmd: both packages ok (8.3s / 19.6s); test alone 0.02-0.08s over 3 runs.
Residual: 3s wall-clock cap in the test is load-sensitive; test owner may widen it (I did not touch tests).

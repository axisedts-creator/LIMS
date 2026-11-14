# T-PERF1 dispute — 5 tests in `load.scenarios.test.ts` cannot pass for any implementation
Run: `npx vitest run src/modules/engagement/__tests__/load.scenarios.test.ts` (services/api): 19 pass, 5 fail. Files under `__tests__/load/` are done.

1. `k6 inspect` ignores process env (3 tests: "SCALE=10 arrival rates", "SCALE=1 is exactly one tenth", "rejects a SCALE other than 1 or 10").
   `inspect()` passes SCALE only via `spawnSync` env. Probe with the same script: env `SCALE=10` and no flag gives timeUnit 16m40s (1x, rate 7/1000 s); `k6 inspect -e SCALE=10` gives 1m40s (10x). So `__ENV.SCALE` is empty under `inspect`; SCALE=3 also exits 0 (default 1). The script cannot read process env any other way in k6.
   Fix: pass `['inspect', '-e', `SCALE=${scale}`, K6_FILE]` (or `--include-system-env-vars`).
2. In-process mock + `spawnSync` deadlock (2 tests: "fast mock: exits 0 ...", "tokens travel in headers only").
   `spawnSync` blocks the Node event loop, so the `http.createServer` mock never reads or answers while k6 runs. k6 `setup()` GET hangs 60 s ("setup() execution timed out"), exit 100, `hits` empty until after the assertions. Any script that sends a request fails. (The slow-mock and refused-env tests pass vacuously: non-zero exit.)
   Fix: use async `spawn` (await close) for `k6 run`, or run the mock in a child process.

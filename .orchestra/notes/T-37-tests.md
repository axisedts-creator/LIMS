# T-37 tests (load 1x/10x, AC-19.4, AC-08.4)
- New (services/api/src/modules/catalog/__tests__/perf/): `priceFor.perf.test.ts` (port priceFor, 5k/50k items, service-time p95 <= 20 ms @1x, 50 ms @10x fake headroom, constant statements, tenant isolation), `readsWrites.perf.test.ts` (list p95 <= 200 ms, write p95 <= 300 ms, write-tx/lock-hold p95 <= 50 ms, one revision bump per write; 100/1,000 departments).
- Already present, same dir: `CatalogPort.perf.test.ts` (T-28a: AC-19.4 warm p95 20 ms, resolveOrderables 50 ms, cold getTest 60 ms), `orderables.search.perf.test.ts` (T-06: AC-08.4, 1x/10x).
- Run: `.orchestra\notes\T-37-verify.cmd` (12 tests, ~40 s). Must run with `--no-file-parallelism`: in parallel, the fake-DB timings are CPU-starved (search 1x total 1529 ms, write 63 ms) and fail spuriously.
- Result today: 12/12 pass against existing impl (perf proxies; impl already exists, so no red phase).
- NOT covered: real-Postgres latency, price import 1k/20k validate/commit timings, k6-style compose-stack run [PIN-C0] (no stack, no k6 here). Fake scans linearly, so 10x budgets are service-time only.

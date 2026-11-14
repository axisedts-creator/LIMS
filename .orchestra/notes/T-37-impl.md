# T-37 impl
- Files changed: none in source. Review item 1: with tester's 20 ms budget at 1x AND 10x (+ gc per sample), priceFor passes without tuning; no loosened number.
- Ran `vitest run --no-file-parallelism src/modules/catalog/__tests__/perf`: 4 files, 12/12 pass (16.8 s); priceFor file re-run: 2/2 pass.
- Review items 2+3: filed `.orchestra/cr/T-37.md` (CR-C3-037) — import 1k/20k timings need worker perf dir in T-37 files (or explicit defer); k6 compose-stack run blocked on [PIN-C0].
- pending.json: untouched (LD-70) — T-37 turns no stub operationIds into real handlers.
- [CONV] none. No dispute.
- Open: CR-C3-037 (import timings, k6/real-Postgres run).

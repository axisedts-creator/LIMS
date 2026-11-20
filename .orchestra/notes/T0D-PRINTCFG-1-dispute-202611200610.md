# T0D-PRINTCFG-1 dispute (debugger, 2026-11-19 02:50 NPT)
rs-c6.screens.test.tsx.snap, worklist block (line ~72), still lacks `button Ready to release` between `button Search` and the first `button Select an item`.
The live render of ReportsWorklist.tsx (T0D-UILIST-1, LD-353 FilterBar Status select) emits it. LD-395 and LD-399 already rule TESTS_WRONG.
The snap is untouched on disk despite LD-400. Fix (tester): insert that one line, or run `vitest -u` on that one test only.
No implementation change is possible or needed; every other suite is green (59/60).

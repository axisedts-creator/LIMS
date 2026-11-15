# WEB-BUILD-1 dispute (writer)
Test: build-boundaries.test.ts:208-215 "(b) the two failing spots are really on the walked graph" expects `reached` to contain `packages/ui/src/components/DiffTable/DiffTable.tsx`.
Why wrong: the brief requires DiffTable.tsx to start with 'use client' (test (c) enforces it), and the walk must stop at 'use client' modules (test at line ~173 asserts such modules are NOT in `reached`). So after the required fix DiffTable can never be in `reached`; the two tests contradict each other. shared.tsx part of the same assertion is fine.
Fix for tester: assert only shared.tsx in `reached` (or assert DiffTable is 'use client' / the audit page imports it).
State: all other 15 tests pass. Impl done (see WEB-BUILD-1-impl.md); real `next build` not yet run (stopped per dispute rule).

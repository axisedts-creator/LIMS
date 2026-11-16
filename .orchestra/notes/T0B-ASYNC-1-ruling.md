TESTS_WRONG — case (3) asserts `unknown == []`, but done_when (3) as amended by LD-279 requires an explicit KNOWN-GAP allowance of exactly seven identifiers.
Reasons:
1. Task brief done_when (3) (.orchestra/inbox/T0B-ASYNC-1-arbiter.md:23) requires a KNOWN-GAP list *inside the test* with exactly: catalog.export_build, catalog.import_validate, catalog.import_commit, homecollection.flag_handover_discrepancy, homecollection.refresh_visit_specimens, identity.notify_ip_throttle, identity.rescan_upload — each with a reason and CR-C0-T0B-ASYNC-1-001.
2. LD-279 (.orchestra/inbox/T0B-ASYNC-1-arbiter.md:36) is binding and overrides spec text for this task; it splits the seven out (ASYNC-2 / founder decision under LD-189). No spec/ text contradicts it (plan 06-IMPLEMENTATION-PLAN.md has no T0B-ASYNC-1 row text to the contrary).
3. services/worker/src/core/__tests__/async-manifests.test.ts:125-134 has no such list (grep KNOWN|CR-C0-T0B-ASYNC-1-001: no match) and expects `[]`, so it fails on exactly those seven — the gap the lead ruled acceptable.
WHAT THE TESTER MUST CHANGE (tester-owned file, per LD-279):
- Add `const KNOWN_GAP: Record<string, string>` with exactly those seven ids, each value = reason + "CR-C0-T0B-ASYNC-1-001" (catalog/homecollection: "manifest written by T0B-ASYNC-2"; identity.*: "founder decision under LD-189, no worker task").
- Assert `unknown` (ids neither declared nor in KNOWN_GAP) `toEqual([])`.
- Add assertion: every KNOWN_GAP id is NOT in `declared` (list can only shrink); fail naming any listed id that is now loaded.
- Optional: assert Object.keys(KNOWN_GAP).length === 7 so the list cannot grow silently.

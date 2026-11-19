# VERIFY-GREEN-8 dispute (debugger, 2026-11-19 4:35pm NPT)
Gate: `apps/web/src/__tests__/vg8.typecheck.test.ts:82` fails 1/8: `expected 90 to be less than or equal to 80` (BASELINE_AS_ANY). The other 7 pass (TS2883 and `tsc -p apps/web` are clean after the tester pass).
- Cause is test-side only. The tester measured that VG8 added 0 `as any`: every file that existed at f944a2cb3 has an unchanged count. The 24 extra come from other tasks' NEW test files (T0D-OFFLINE-1 6, T0D-PRINTCFG-1 9, T0D-ELABMENU-1 4, T0D-WEBFIX-2 4, +1 offline3.fixtures). Ruling 757347041 / LD-425 forbids touching them.
- No product file is involved; the debugger may not edit tests; no implementation fix exists.
- Spec line: task brief done_when, "No ... `as any` ... added" (VG8 added none). The gate baseline of 80 is stale against other lanes' later files.
- Lead decision needed: raise BASELINE_AS_ANY to 90 (gate edit by tester), or open a task to narrow those casts in the four other tasks' files.
Stopping.

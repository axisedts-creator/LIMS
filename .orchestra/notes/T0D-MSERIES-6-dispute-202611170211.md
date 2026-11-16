# T0D-MSERIES-6 dispute (writer, round 6, 2026-11-17 01:25 NPT, after LD-303)
Tester stage did not run again: rs-c2.baseline.json last commit is still ec073f164. Writer changed nothing (may not edit tests/baseline).
Verify re-run on HEAD 610882569: apps/web m6 422/425; 3 reds, all rs-c2.static.test.ts (lines 122, 125, 134). packages/ui step not reached (verify uses &&).
Allowed per LD-298/LD-303 and present: actions.ts hash, messages.ts hash, route app/(auth)/auth/waking/page.tsx, field_names minus x-forwarded-for, x-real-ip.
NEW, NOT ALLOWED by LD-303 ("if any other entry differs, stop and write a blocking CR"): data_files hashes of
  features/platform/actions.ts  7f6c66d9...b5e -> 6a19465c...b9d
  features/platform/shared.ts   7ecda1df...fe5 -> 6a2d3c5d...fb91
Cause: 9677e24a3 "[writer] PLATFORM-PROVISION-1 impl" (merged on main, LD-293), not MSERIES-6.
So a tester re-record under the LD-303 rule must stop again. LEAD must also allow these two platform hashes (PROVISION-1 drift) and route the re-record to the TESTER stage, not the writer.
ESCALATE TO LEAD. No code change needed for MSERIES-6.

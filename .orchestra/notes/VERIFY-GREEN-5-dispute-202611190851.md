# VERIFY-GREEN-5 dispute (debugger, 2026-11-19)
Failing: rs-c6.screens.test.tsx:190 (`getAllByRole('tab')` = 6) and :214 worklist snapshot (extra `button Ready to release`). Not VG5 code: both fail identically with the LD-405 tsconfig edit reverted.
Cause: T0D-UILIST-1 impl (74ea3e301) replaced the worklist tab bar with one FilterBar status select (ReportsWorklist.tsx:97-125), per LD-353 template 1 (inbox T0D-UILIST-1-arbiter.md:29-30, binding). rs-c6.screens was written for tabs and its snapshot was not regenerated (LD-362 covered instruments only; T0D-UILIST-1-impl.md:2).
Test contradicts LD-353, and the file is C6/UILIST-owned, outside VG5 files. No VG5 implementation fix exists; reverting the worklist would undo LD-353.
Ask lead: (a) drop rs-c6 from VG5 verify.cmd, or (b) rule on revising rs-c6.screens:190 and regenerating the worklist snapshot under T0D-UILIST-1.

# T0D-PRINTCFG-1 dispute (debugger, round 2)
Verify log now fails 2 tests, both on ReportsWorklist.tsx (not a PRINTCFG file; last changed by 74ea3e301 [writer] T0D-UILIST-1): rs-c6.screens "worklist" snapshot (new "Ready to release" status button) and rs-c6.static "same form field names" (`lookup` gone from extracted names).
Tests pin pre-LD-353 markup; LD-353 template 1 (ONE FilterBar holding lookup + status) replaced it. Same T0D-UILIST-1 drift as T0D-PRINTCFG-1-ruling.md line 7 (3 c6-t31 cases).
Not fixable in implementation without reverting UILIST-1. Lead to re-record rs-c6 snapshot and field_names baseline. Stopping.

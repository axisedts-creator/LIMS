# T0D-PRINTCFG-1 debug (debugger)
Cause: verify log shows 3 failures, all in c6-t31.screens.test.tsx (worklist lookup input, CriticalAlertsPanel role="alert"). Source files ReportsWorklist.tsx / CriticalAlertsPanel.tsx unchanged by PRINTCFG; broken earlier by 74ea3e301 T0D-UILIST-1 restyle (LD-353 ErrorState).
Fix: none in implementation. PRINTCFG suites green (printcfg1 72/72, rs-c2 74). No code edited.
Dispute filed: .orchestra/notes/T0D-PRINTCFG-1-dispute.md. Lead to refresh c6-t31 / rs-c6 pins for T0D-UILIST-1.

# T0D-PRINTCFG-1 dispute (debugger)
Remaining 3 failures (c6-t31.screens.test.tsx: worklist lookup field line 112, CriticalAlertsPanel error alert line 289, plus 1 more in the same two-file run) fail on files this task does not touch: ReportsWorklist.tsx and CriticalAlertsPanel.tsx, last changed by 74ea3e301 [writer] T0D-UILIST-1.
The tests pin the C6-T31 markup (role="alert" error box, worklist "lookup" input). T0D-UILIST-1 replaced it with the LD-353 rule 6 ErrorState (title + Retry, no role="alert"), the current spec. Test is stale, not the PRINTCFG implementation.
Not fixable in implementation without reverting T0D-UILIST-1 (out of this task's files). Route to lead as T0D-UILIST-1 drift; same as .orchestra/notes/T0D-PRINTCFG-1-ruling.md line 7. Stopping.

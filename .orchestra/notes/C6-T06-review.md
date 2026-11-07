APPROVE

Re-review after 1693f71 + 6d270e9. verify.cmd: 75/75 pass (2 files).
1. print_critical_label: now top-level `printCriticalLabel` on AssemblyInput/BuildDocumentInput, passed through; assembly test covers HH -> "Critical High" and default "High". Fixed.
2. AssetRef.mimeType optional: CR filed at .orchestra/cr/C6-T06.md (CR-C6-023, non-blocking), [CONV] comment cites it. Fixed.
3. Comment texts keyed `${departmentId}|${code}` in assembly and builder; two-department same-code tests in both suites. Fixed.
No new defects: owned paths only, no SQL/RLS in scope, no PHI in logs, no secrets.

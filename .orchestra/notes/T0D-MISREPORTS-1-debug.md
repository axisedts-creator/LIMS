## Debugger 2026-11-20
Cause: 2 rs-c8 snapshot failures (Report hub tabs, New schedule form) = stale .snap files, last committed 6c1b8b4c1; they lack the new catalogue rows the brief requires.
Fix: none in implementation code (it is correct). Test-side re-record with -u needed; see T0D-MISREPORTS-1-dispute.md. Stopped per role rule.

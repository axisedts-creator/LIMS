APPROVE
Round 2. Both round-1 items are fixed:
1. t-r2 range helper now tabs out after typing (tester, 4a7d96110). The server-page test now looks up the R1 GET by pathname instead of taking the first GET, and it still checks the due_from/due_to ISO instants and the 92-day span. Not weakened.
2. impl note items 6 and 7 are corrected (writer, 33290acd2).
Re-run on HEAD: uiguard1 guard 36/36, engagement states 20/20, t-r2 33/33.
Unchanged from round 1 and still OK: no ENGAGEMENT registry entries and none added; mirror lines deleted; kit props additive only (date_range maxDays?, Timeline aria-label?); tokens.json, kit.css and shell.css untouched; no route, permission, API or contract change; no pinned paths; no PHI or secrets.

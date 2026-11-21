APPROVE

Reviewed b98f9b22b..HEAD (tester 7783ad1b3, writer c2a562c7e) for T0D-UIGUARD-1-OFFLINE.
- Rule 1: kit PageHeader on /offline (title offline.title, helpKey, Sync now in actions). Rule 4: missing snapshot draws kit NotAvailable. Rule 7: no raw h1-h4/ul/ol in OfflinePanel/OfflineShell/OfflineParts (dialog and resolve-side titles use role=heading, same accessible level).
- Registry: tester removed the 3 OFFLINE entries (rule 1, 4, 7) from uiguard1.exceptions.ts; writer removed both OFFLINE sections from notes/T0D-UIGUARD-1-exceptions.md and did not touch the registry (LD-441). Nothing added.
- Display only: no route, permission, contract, operation or API change; all controls, gates and controller calls unchanged. tokens.json, kit.css, shell.css, pinned paths untouched. No PHI, no secrets. No T0D-OFFLINE-* task lists these files.
- Checks run by reviewer: uiguard1 guard 36/36, uiguard1-offline 11/11, offline2 140/140, offline3 88/88, offline4 58/58 — all green.
- Not verified: pixel match to the Worklist mock (no browser), as the writer notes say.

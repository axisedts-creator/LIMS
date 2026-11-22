
## LEAD ITEM LD-443 (11:20 NPT)
Snapshots under __snapshots__ are writer or reviewer owned, never tester owned (LD-440, LD-443). Tester: do not run vitest -u, only name stale snapshots in your tests note. Writer or reviewer: regenerate a stale rs-cN screens snapshot with -u after reading the diff, only when the diff is markup (table, dl, button, kit classes, react-aria ids) and no text or data changes. A stale snapshot is not a test dispute.

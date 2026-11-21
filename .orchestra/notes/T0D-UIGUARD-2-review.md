APPROVE

Range 613af74bf..ed9c60ba1 (2 commits, 4 files).
- uiguard1.exceptions.ts:112-116: tester (2061115eb) added legacy('PARTNERS', 2, 'TicketInbox.tsx', ['/partners/tickets', '/partners/tickets/[ticket_id]']) with the existing LD-434 helper; reason resolves to 'legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: rule 2 broken in TicketInbox.tsx', matching LD-441 (1).
- Mirror lines present in notes/T0D-UIGUARD-1-exceptions.md:152-153 (route + "rule 2"); writer did not touch the registry or TicketInbox.tsx (LD-441 (2)). Role split per LD-441 holds.
- Stale check stays in force, so the two entries must go when T0D-UIGUARD-1-PARTNERS lands (LD-439 b).
- No route, permission, contract, API, PHI, secret or tenant/RLS surface touched; only test registry and notes. No invented names.
- Ran verify.cmd (build:nav + vitest uiguard1 config): 2 files, 36/36 passed, 2026-11-21 22:53.

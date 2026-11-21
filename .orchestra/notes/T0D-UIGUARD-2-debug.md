# T0D-UIGUARD-2 debug
- Cause: rule 2 red for /partners/tickets(+[ticket_id]); TicketInbox.tsx hand builds a filter row. Writer's "impl per ruling" commit changed only the notes mirror; the registry entries were never added to uiguard1.exceptions.ts.
- Fix: added legacy('PARTNERS', 2, 'TicketInbox.tsx', [2 routes]) to uiguard1.exceptions.ts (ruling option B). Tests and TicketInbox.tsx untouched.
- Check: verify.cmd (build:nav + vitest uiguard1 config) 36/36 pass.

# T0D-UIGUARD-2 impl (writer)
- Changed: notes/T0D-UIGUARD-1-exceptions.md (+ rule 7 section: STANDING catch-all + 18 area groups, 134 lines, copied verbatim from .orchestra/notes/T0D-UIGUARD-2-exceptions-lines.md; + 2 rule 2 PARTNERS lines, header 16 -> 18).
- Registry (uiguard1.exceptions.ts) NOT edited by writer (LD-441: tester-owned); tester added the 2 PARTNERS rule 2 entries in 2061115eb. No review.md existed; no implementation items left.
- [CONV] rule 7 block under its own "# Rule 7" heading at the end of the mirror file; rule 2 TicketInbox entries placed in the existing PARTNERS rule 2 group.
- Check (2026-11-21 22:52, after tester registry commit): verify.cmd = build:nav + vitest uiguard1 config: 36/36 pass.
- Open: TicketInbox.tsx not touched (owned by open T0D-UIGUARD-1-PARTNERS); its 2 rule 2 entries go stale when that task swaps in kit FilterBar (breach came from T0D-MSGDESK-1 after UIGUARD-1).

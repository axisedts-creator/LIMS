# T-N1 debug (2026-11-14)
Cause: all 8 reds = N3 staff reply -> `repo.insertReplyNotification` (enquiry.service.ts:141-142) refused by world (notifications INSERT SYS-only, 05-SCHEMA §5.2 line 1347) -> `common.internal`. Tests match spec; impl fail-closed is the interim from CR-C16-T-N1.
Fix: none possible without inventing a system-actor task/DEFINER name (CLAUDE.md forbids). Not a test defect, so no dispute. BLOCKED on owner ruling of .orchestra/cr/T-N1.md (option A task or B DEFINER); then writer wires it.
Did not touch tests or code.

## Round 2
Same 8 reds, same cause: N3 `insertReplyNotification` (enquiry.service.ts:141-142) refused by SYS-only notifications INSERT (05-SCHEMA §5.2 l.1347) -> common.internal; race test red only because reply 1 now fails.
No ruling on .orchestra/cr/T-N1.md yet (grep spec/program for CR-C16-T-N1 / DEFINER / enquiry_reply: no hits). Fix would need an invented task/DEFINER name -> forbidden. Tests match spec, no dispute.
Still BLOCKED on owner ruling (A task or B DEFINER). No code/test change.

## Round 3
Same 8 reds, same cause: N3 `insertReplyNotification` (enquiry.service.ts:141-142) refused by SYS-only notifications INSERT (05-SCHEMA §5.2 l.1347) -> common.internal.
Re-checked: no ruling on .orchestra/cr/T-N1.md; no task/DEFINER name in 08-CR-REGISTER, 03-INTERFACE-CATALOG or 02-TRD (only l.357 kind row). Naming one = inventing (CLAUDE.md). Tests match spec, no dispute.
Still BLOCKED on owner ruling (A task or B DEFINER). No code/test change.

# T-N1 debug (2026-11-14)
Cause: all 8 reds = N3 staff reply -> `repo.insertReplyNotification` (enquiry.service.ts:141-142) refused by world (notifications INSERT SYS-only, 05-SCHEMA §5.2 line 1347) -> `common.internal`. Tests match spec; impl fail-closed is the interim from CR-C16-T-N1.
Fix: none possible without inventing a system-actor task/DEFINER name (CLAUDE.md forbids). Not a test defect, so no dispute. BLOCKED on owner ruling of .orchestra/cr/T-N1.md (option A task or B DEFINER); then writer wires it.
Did not touch tests or code.

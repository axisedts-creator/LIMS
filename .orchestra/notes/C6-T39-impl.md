# C6-T39 impl
- services/api/src/modules/reporting/domain/messages.ts: `label_text` no longer rejects `<`/`>` (08 A4.3 / TRD §14 (c): accepted + stored raw) [CONV: follows §14(c), not §7.2 "no markup"].
- services/worker/src/jobs/reporting/tasks/send_delivery.ts: `fill` takes `esc`; e-mail body + subject HTML-escape param values (& < > " '); sms/whatsapp unchanged.
- (a) first-assembly snapshot, (b) getStaffNotificationContact, (d) portal HealthSummary: tests were already green per tester note; no code change.
- NOT RUN: `.orchestra/notes/C6-T39-verify.cmd` — command execution was not approved in this session, so the fix is unverified.
- Open: worker `resolveRecipient` has no 'staff' branch (outside T39 files; flag to lead). pending.json untouched (no stub ops became real handlers).

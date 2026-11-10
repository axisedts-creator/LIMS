# C6-T39 impl
- services/api/src/modules/reporting/domain/messages.ts: `label_text` no longer rejects `<`/`>` (08 A4.3 / TRD §14 (c): accepted + stored raw) [CONV: follows §14(c), not §7.2 "no markup"].
- services/worker/src/jobs/reporting/tasks/send_delivery.ts: `fill` takes `esc`; e-mail body + subject HTML-escape param values (& < > " '); sms/whatsapp unchanged.
- services/api/vitest.config.ts: LD-87 `testTimeout: 60000` + `hookTimeout: 60000` inside `test:` only.
- Verify run (2026-11-10): api 3 files 97/97 pass; portal HealthSummary 6/6 pass; worker 8/11 — the 3 failures are the 5000 ms default timeout in t39.a4.first_assembly.test.ts (each test takes 5.6–7.7 s under load). With `--testTimeout=60000` worker passes 11/11.
- Open (lead): LD-87 covers only services/api/vitest.config.ts; services/worker/vitest.config.ts needs the same timeout edit for verify.cmd to go green. Not edited (not authorised).
- Open: worker `resolveRecipient` has no 'staff' branch (outside T39 files; flag to lead). pending.json untouched (no stub ops became real handlers).

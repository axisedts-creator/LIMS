# AN-T20 debug
- Cause: both red tests (schedules l.182 creator chip; l.436 hostile name) need `ShellSession.actor.membershipId`, which does not exist (core/session/types.ts:9-14, c2.ts:73). schedules-page.tsx:53 already reads it; harness no longer fakes it (review #2). Impl is correct per 04-UI-UX §8; the field is missing.
- No fix in C8 paths: `apps/web/src/core/**` is C0-0D's (01-CHUNK-MAP §3). Name-matching workaround rejected in CR (names not unique). Blocked on `.orchestra/cr/AN-T20.md` (CR-C8-001, C2 + C0-0D).
- l.436 is also a test defect: hostile name is only visible via the creator chip. Tester should pick the recipient explicitly (type name, click option) so REQ-SEC-088 does not hinge on the CR. I may not edit tests.
- Other 135/137 pass. No code changed.

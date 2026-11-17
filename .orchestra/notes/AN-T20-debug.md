# AN-T20 debug
- Cause: both red tests (schedules l.182 creator chip; l.436 hostile name) need `ShellSession.actor.membershipId`, which does not exist (core/session/types.ts:9-14, c2.ts:73). schedules-page.tsx:53 already reads it; harness no longer fakes it (review #2). Impl is correct per 04-UI-UX §8; the field is missing.
- No fix in C8 paths: `apps/web/src/core/**` is C0-0D's (01-CHUNK-MAP §3). Name-matching workaround rejected in CR (names not unique). Blocked on `.orchestra/cr/AN-T20.md` (CR-C8-001, C2 + C0-0D).
- l.436 is also a test defect: hostile name is only visible via the creator chip. Tester should pick the recipient explicitly (type name, click option) so REQ-SEC-088 does not hinge on the CR. I may not edit tests.
- Other 135/137 pass. No code changed.

## Round 2
- Re-verified: same 2 reds (schedules l.182, l.436). `membershipId` still absent from core/session/types.ts; CR-C8-001 (.orchestra/cr/AN-T20.md) still open. schedules-page.tsx:52-54 already reads it, so no C8 fix exists.
- Only workaround is displayName matching (names not unique, rejected in CR) or editing core/** (not C8-owned). No code changed.
- Unblock: land CR-C8-001 (l.182 goes green). l.436 still needs the tester to pick the recipient explicitly instead of relying on the creator chip.

## Round 3
- Same 2 reds (schedules l.182, l.436); 135/137 pass. `membershipId` exists only on server-side `BffSession` (core/session/store.ts:13), not on `ShellSession.actor` (core/session/types.ts); schedules-page.tsx:52-54 already consumes it. CR-C8-001 still open.
- No C8-owned fix exists (core/** belongs to C0-0D). No code changed. Needs CR landed + tester fix for l.436.

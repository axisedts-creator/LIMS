# T0B-PROVFIX-1 impl (writer)
- services/api/src/modules/identity/service/tenant.service.ts: seedIrdAnnexes moved to FIRST statement inside scoped(ctx, id, ...) (LD-294 comment); interface comment updated.
- Tests: tenant.service + tenant.handlers 177/177 pass (.orchestra/notes/T0B-PROVFIX-1-verify.cmd).
- BLOCKER: inside the scope app.is_platform_actor() is false (tx.ts:186 system-actor claims) and ird_annex_records has only the __platform INSERT
  policy, so staging will still answer Not found (42501 on ird_annex_records). Needs a DB change: .orchestra/cr/T0B-PROVFIX-1.md (Blocking? yes), dispute note filed.
- Static review: .orchestra/notes/T0B-PROVFIX-1-review.md (all other provision statements admitted; other operations: no outside-scope audited writes).
- [CONV] none. Open: pick CR option; option 1 means moving the call back outside and reversing the tester's ordering test.

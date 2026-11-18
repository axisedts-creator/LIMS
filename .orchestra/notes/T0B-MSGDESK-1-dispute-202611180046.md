# T0B-MSGDESK-1 dispute (writer). TESTS_WRONG, 2 items; implementation otherwise green (PG17 run2: 136/137, log T0B-MSGDESK-1-wrun2.log)
1. engagement/__tests__/msgdesk/templates.test.ts:44, case `{{party_name}`: the "nothing stored" check is `body LIKE '%' || ph || '%'`. `{{party_name}` is a substring of
   every VALID template body `{{party_name}}` (mk() and earlier tests store them), so the count is > 0 whatever the handler does. The handler does refuse the body
   (the 422 code assertion on line 41 passes). Fix: match the exact submitted body, e.g. `body = $2` with `Hello ${ph} today`, or `body LIKE '%' || ph || ' today%'`.
2. partners/__tests__/boot.test.ts:40-56 IMPLEMENTED (tester-owned, "that task moves its ids here"): the 10 ticket ids of T0B-MSGDESK-1 are missing, so the two
   stub tests (lines 114, 124) call the real ticket handlers as if they were T01 stubs (dev: auth.forbidden instead of 501; staging: resolves the gate path differently).
   Fix: add 'createPartnerTicket', 'listPartnerTickets', 'getPartnerTicket', 'replyPartnerTicket', 'closePartnerTicket', 'reopenPartnerTicket',
   'listMyPartnerTickets', 'createMyPartnerTicket', 'getMyPartnerTicket', 'replyMyPartnerTicket' to IMPLEMENTED (same move every earlier handler task made).
Not from this task (fail without these files): engagement boot.test PHASE_STUBS QualityPort (T0C-MSGDESK-1 ruling item 6); partners contract/msgdesk1.pending.test.ts:28
pins pending to MSGDESK ids but the list holds the 15 T0C-SALES-1 ids (arbiter b182e7445 TESTS_WRONG, still unfixed).

# T0C-MSGDESK-1 dispute (writer) — older tests contradict the brief and msgdesk1 tests
Implementation is complete. These pass: msgdesk1-openapi (incl. lint + codegen freshness) + c13 + codegen.test (591/591); both msgdesk1.pending tests; core pending-operations; pgTAP T0C-MSGDESK-1 suite + 5 new isolation probes (no `not ok`); api tsc clean.
Still failing in services/api (64 tests). None can pass without editing a test file:

1. CONFLICT (needs a ruling, not just a re-pin): `partners/__tests__/probes/st4-actor-type.test.ts` "AB5/AB6 contract ... no code shared across the two sides".
   The brief (done_when 5) gives exactly 5 new codes, with partners.ticket.read/.manage used by both the lab side (/admin/tickets) and partner users (/me/tickets).
   msgdesk1-openapi.test.ts pins it: every code has tenant_admin in roles AND partner_member holds partners.ticket.read/.manage, AND the registry grows by exactly 5 codes.
   So a shared code is required by one test and forbidden by the other. Security is kept: RLS binds partner actors to party_id = app.current_partner_id()
   (pgTAP proven), and T0B-MSGDESK-1 must add the per-path actor gate (/admin = user only, /me = partner only), as every other C13 handler does.
   Options: (a) ruling that partners.ticket.* is the one listed exception to AB5/AB6 (I extended the gen-permissions R3 exception the same way, [CONV]);
   (b) new partner-only codes (e.g. a partners.ticket submit code) — needs a lead decision, since LD-321 lists exactly these 5.
   The 40 "listMyPartnerTickets/... as actor X -> 403" cases fail because the 10 ops are T01 stubs (not in kit UNOWNED_STUBS); T0B-MSGDESK-1 handlers fix them, or the tester adds the ids to UNOWNED_STUBS meanwhile.
2. STALE PINS (TESTS_WRONG, same kind as the T0C-LINTFIX-1 ruling): every additive contract task breaks them.
   - partners boot.test.ts: 68 operationIds, 68 mounted, the literal 14 partners.* codes; st4 "68 ops"; not-found.probes (6): the new stub ops answer common.internal, not 404 (not in UNOWNED_STUBS).
   - engagement boot.test.ts (98 ops, handler set), display.board.test.ts, probes/operations.matrix.test.ts (98 / 94): hard-coded op counts / sets.
   - identity role-packs: admin-all-permissions (162, "only the 7 billing codes"), admin-authority (privileged 62), role-packs.data (162/62), role-packs.loader (162): corp_admin now 167 / 63 because the brief requires the 5 codes in the corp_admin pack.
3. NOT FROM THIS TASK (by inspection, files untouched): identity ci-scripts "service key read outside gateway.http.ts"; engagement boot "PHASE_STUBS ... QualityPort"; c16-openapi "Profile fields 8 vs 7" (T-L6 field).
Not run: full tools/codegen suite (stopped at the 20 min limit); full repo db suites.

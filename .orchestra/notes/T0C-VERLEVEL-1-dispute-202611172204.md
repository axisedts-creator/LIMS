# T0C-VERLEVEL-1 dispute (writer, after tester revision 1077f4140)
Verify re-run 2026-11-17 ~22:00 NPT. GREEN: codegen verlevel1 + c5 + lint-openapi 577/577; API pending + registry.static + 4 role-pack files 299/299; lab boot.test T-01 3/3; pgTAP T0C-VERLEVEL-1_verification_levels: no `not ok`, exit clean (165 s).
RED (2 cases, not caused by this task): contracts/__tests__/registry-equality.test.ts
- :104 errors.yaml == IC §8: extra codes allowed are exactly LD322_SYNC_ERRORS + LD316_VERLEVEL_ERRORS; received also engagement.broadcast_invalid_transition, _placeholder_unknown, _provider_not_configured, _recipient_limit, _self_approval, _template_inactive, partners.ticket_invalid_transition.
- :191 permissions.yaml == IC §11: received also partners.ticket.read, partners.ticket.manage (and the engagement.broadcast.* codes).
Cause: T0C-MSGDESK-1 codes (LD-321) arrived via the main merge c4bc5948b; main's own registry-equality.test.ts has no allowance for them either (git grep "broadcast" = 0), so main is red on these cases too. The 3 VERLEVEL error codes and 2 permission codes are accepted by the test.
Ask: tester (or MSGDESK owner) adds the LD-321 MSGDESK codes to the allowance lists, as done for LD-322/LD-316. No implementation change needed.
Side effect: run-suites.sh regenerated isolation probes (adds `\ir core.sql` include + probe rows) in lab, engagement and partners probe files; left uncommitted.

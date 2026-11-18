# T0C-VERLEVEL-1 dispute (writer, 2026-11-17 22:10 NPT, after tests revised per ruling cfbafcab8)
- Verify rerun: codegen 577/577, API 299/299 + boot 3/3, pgTAP T0C-VERLEVEL-1 suite no "not ok"; registry-equality `errors.yaml == IC` green.
- Still red: contracts/__tests__/registry-equality.test.ts:195 (`permissions.yaml == IC §11`, fixed_actor_permissions exact equality): received partner fixed actor extra `partners.ticket.read`, `partners.ticket.manage`.
- Origin: added by 391a69686 `[writer] T0C-MSGDESK-1 impl` (LD-321), merged from main; T0C-VERLEVEL-1 does not touch fixed_actor_permissions.
- The ruling added LD321_MSGDESK_CODES only to the `permissions` extra list (:199+), not to the fixed_actor_permissions comparison at :195; same TESTS_WRONG reason applies.
- Suggested test change (tester): at :195 compare against IC fixed_actor_permissions with the partner list extended by exactly ["partners.ticket.read", "partners.ticket.manage"] (LD-321), keep it exact. No implementation change.
- Side: run-suites.sh left db/tests/fixtures/probe-rows/{engagement,lab,partners}.sql modified; not committed (revert was blocked by permission prompt).

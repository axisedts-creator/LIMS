# T0B-SALES-1 dispute (round 8, after 9130c7ad9 / LD-373; code unchanged)
FACT: 3 verify runs, all identical: main 1 failed | 3491 passed | 1 skipped (3493); timing command 6/6 green (no retry needed beyond LD-355). LD-373 permissions.test.ts now green.
ONLY RED: services/api/src/modules/homecollection/__tests__/sync/effects.test.ts:314
  "handover_confirmation_required = false -> status confirmed at once ..." expected ['confirmed', null, received_at] got ['pending', null, 0].
CAUSE (TESTS_WRONG, isolation, same pattern as LD-363 guards.test.ts:252): line 308 calls setSettings(TENANT_B, 'handover_confirmation_required = $2', [false])
  BEFORE pushWorld (line 310). setSettings is a plain UPDATE (snapshot/helpers.ts) that is a no-op when the shared tenant B settings row is absent/replaced
  at that moment; pushWorld then seeds with ON CONFLICT DO NOTHING and the default (true) wins, so the handover stays pending. Not sales code:
  this task does not touch handover confirmation.
ASK: TESTER changes setup only of effects.test.ts:308 the LD-363 way (upsert ON CONFLICT (tenant_id) DO UPDATE, or call setSettings after pushWorld); line 315 restore likewise.
  Suggest also grepping homecollection __tests__ for other setSettings-before-pushWorld calls and fixing them in the same pass, so this does not come back one file at a time.
  No assertion changed. No implementation change. Writer stops here per inbox rule.

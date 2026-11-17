# T0C-SYNC-1 dispute (writer, 2026-11-17 22:40 NPT)
TESTS_WRONG (stale after main merge), SYNC-1 code not at fault. No implementation file changed in this round (review items were already applied: requestSyncDeviceWipe rename, CORE_PENDING_OPERATIONS).
Verify run step by step from the lane root (the single line in T0C-SYNC-1-verify.cmd):
- tools/codegen sync1 + lintfix1: 2 files, 88/88 pass.
- services/api sync1.pending, health, role-packs (4 files): 6 files, 248/248 pass.
- pgTAP db/tests/core/T0C-SYNC-1_sync_devices_blocks.test.sql via run-suites.sh: exit 0.
- contracts registry-equality: 12/14, 2 red:
  1. `errors.yaml == IC §8` (registry-equality.test.ts:100) pins the codes outside IC to exactly LD322_SYNC_ERRORS. Received also: engagement.broadcast_invalid_transition, engagement.broadcast_placeholder_unknown, engagement.broadcast_provider_not_configured, engagement.broadcast_recipient_limit, engagement.broadcast_self_approval, engagement.broadcast_template_inactive, partners.ticket_invalid_transition.
  2. `permissions.yaml == IC §11` (line 193 pins extras to LD313 + LD321 + LD322 codes): partner role list now also has partners.ticket.read, partners.ticket.manage.
Cause: these 7 error codes and 2 permission codes come from 391a69686 [writer] T0C-MSGDESK-1 impl (lane C0-0C), reached this lane through the main merge; IC §8/§11 lack them and the test allow-lists know only ACCT, SALES and SYNC.
Fix (tester or lead, not writer): add an LD MSGDESK allow-list (the 7 error codes; the 2 permission codes and their partner role grants) to registry-equality.test.ts, or add them to IC §8/§11 (lead, like LD-337). Never drop them from errors.yaml/permissions.yaml (LD-330 keep both sides).

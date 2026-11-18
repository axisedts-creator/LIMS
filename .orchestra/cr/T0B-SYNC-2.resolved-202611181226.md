Title: CR-C0-SYNC2-001: register sync.op_type_not_available (IC §8) and map the pull types worklist_item / permission
From chunk: C0 (T0B-SYNC-2, lane C0-0H)      To owner: C0-0C (contracts) / lead
Type: api
Blocking? yes, for a green registry-equality (contracts/__tests__/registry-equality.test.ts, AC-0C-1.3 errors.yaml == IC §8); no, for the engine itself

Problem:
1. The T0B-SYNC-2 brief (done_when 1, LD-322) names the closed code `sync.op_type_not_available` for an operation type without an adapter, and the
   T0B-SYNC-2 tests demand it in contracts/errors.yaml (owner C0, 422) and in core.yaml SyncErrorCode. It is not in IC §8
   (spec/program/03-INTERFACE-CATALOG.md), so registry-equality fails: errors.yaml has 31 sync/... entries, IC §8 has 30.
2. SyncEntityType lists worklist_item and permission, but no contract names their source with a uuid id for SyncUpsert: listWorklistItems
   (lab.yaml, lab.worklist.read) reads several lab tables; permission codes (core.g_permissions) are keyed by code, not uuid, and global.
   pullChanges answers auth.forbidden for both (fail closed) until mapped.

Proposed change (exact):
1. IC §8, after sync.entity_changed: `- { code: sync.op_type_not_available, http: 422, owner: C0, title: "Operation type not available", meaning: "The server cannot apply this operation type yet; keep it queued or redo it online" }`
   (already applied in contracts/errors.yaml and core.yaml SyncErrorCode on lane/C0-0H; clients regenerated).
2. Lead ruling: worklist_item = which table and id (lab.order_tests? lab.results?), permission = the caller's own permission codes (needs a non uuid
   id shape or its own response block) or drop it from SyncEntityType.

Backward compatible? yes (one new code; one more enum value of a response field).
Tenant/security impact: none; the unmapped pull types stay closed (auth.forbidden), no new data surface.
Alternatives considered: answering common.internal for a missing adapter (rejected: the brief forbids a server error); an empty page for the
unmapped pull types (rejected: a silent success).
Tests that will prove it: registry-equality 14/14; tools/codegen sync2-openapi (its exact sync.* list needs the new code, see dispute);
sync2.registry.static.test.ts (already green).

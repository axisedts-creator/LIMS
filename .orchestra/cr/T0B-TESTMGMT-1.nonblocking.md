Title: CR-C0-TESTMGMT-1: catalog.changed.v1 entity_type "test_category" + is_active on listCommentCodes
From chunk: C0 (T0B-TESTMGMT-1, writer)            To owner: C0-0C (contracts)
Type: event + api
Blocking? no (worked around, flagged [CONV] in code)
Problem:
1. createTestCategory / updateTestCategory must bump the catalog revision and publish catalog.changed.v1 (tests: categories.test.ts "audit and events").
   contracts/events/catalog.changed.v1.schema.json entity_type has no value for a test category, and the event schema fails closed.
   Work-around: categories bump as entity_type "department" (service/categories.service.ts ENTITY), entity_id = the category id.
2. done_when (5) "deactivate instead of delete for notes": a deactivated note must stay listable (panelsNotes.test.ts uses listCommentCodes ?is_active=all).
   catalog.yaml #57 listCommentCodes has no is_active parameter. Work-around: the service accepts is_active true | false | all (default true), the [CONV] of every other catalog list.
Proposed change (exact):
- catalog.changed.v1.schema.json payload.entity_type enum: add "test_category" (additive; x-extensible already true). Then ENTITY = 'test_category'.
- catalog.yaml listCommentCodes parameters: add `- name: is_active, in: query, required: false, schema: { type: string, maxLength: 5, enum: ["true","false","all"], default: "true" }` (copy of listTestCategories).
Backward compatible? yes (additive enum value; new optional query parameter, default = today's behaviour).
Tenant/security impact: none (no new field, no RLS change).
Alternatives considered: entity_type "test" (would try to stamp an orderable with the category id); no event (breaks the revision / cache contract).
Tests that will prove it: categories.test.ts change_kind sequence (unchanged); a contract test for the new enum value / parameter (C0-0C).

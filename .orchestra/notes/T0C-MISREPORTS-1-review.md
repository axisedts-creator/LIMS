APPROVE

Scope reviewed: git diff 0beb096b6..HEAD (759d6279c tester, 9646158f3 writer), LD-357 reset.
- analytics.yaml: net_billed_paisa -> net_paisa (title Net) in sales_representative (column + default_sort), repeated_patient, party_billing; exactly the LD-357 set. referral_incentive keeps net_billed_paisa (D-44); two_level_commission keeps it inside the A39/LD-342 gate (LD-357 says nothing else changes). net_paisa is an existing contract name (verbatim). Additive, no new route, permission, error code or migration change.
- misreports1-openapi.test.ts: pin updated, new case "LD-357 / P13" bans net_billed_paisa outside referral_incentive/two_level_commission/tds; no case deleted, skipped or weakened. c8-openapi.test.ts untouched.
- Owned paths only (contracts/openapi, tools/codegen tests, own notes). No PHI, no secrets. Report defs are not in generated clients, so no regen diff expected.
- Ran: vitest misreports1-openapi + c8-openapi --testTimeout=60000: 295/295 passed. With the default 5000 ms, 2-4 lintRepo cases time out under machine load (different cases each run); not a defect of this diff.
- Note: working tree has unrelated uncommitted edits to db/tests/fixtures/probe-rows/{core,engagement,partners}.sql; not part of this diff, not reviewed.

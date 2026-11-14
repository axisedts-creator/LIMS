TESTS_WRONG — fixture `handoverWorld({ s: 'b', status != 'pending' })` seeds a row the spec schema forbids; the 3 disputed tests never reach the task.
Reasons:
- spec/chunks/C17-home-collection/05-SCHEMA.md:501 — `handovers__receiver__fk FOREIGN KEY (tenant_id, received_by_membership_id) REFERENCES core.memberships (tenant_id, id)`: receiver must be a membership of the handover's own tenant.
- services/api/src/modules/homecollection/__tests__/handovers/world.ts:66 sets `received_by_membership_id: RECEIVER.membershipId` (tenant-A membership a50a, world.ts:12) for every side, so side `b` violates the FK at seed time (world.ts:69).
- 05-SCHEMA.md:129 / 03-APP-FLOW.md:48 allow received_by_membership_id NULL or a valid receiver; nothing requires a cross-tenant receiver.
- 01-PRD.md:189 (US-12-2, D-125) only requires the receiver to be non-member of the home-collection centre, inside the same tenant — side `a` already covers that with RECEIVER.
Change in test (world.ts:66 only): use a tenant-B membership for side `b`, e.g.
  `received_by_membership_id: s === 'a' ? RECEIVER.membershipId : MEMBER.b`
(or the seeded tenant-B staff `01a1a98a-ac40-7000-8000-00000000b500`). Do NOT change assertions of the 3 tests; re-run them after the fixture fix and judge the task on their results.

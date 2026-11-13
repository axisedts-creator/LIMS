# HC-T14 dispute — worker test fixture is wrong for tenant B (3 tests)

Tests: `flag_handover_discrepancy.live.test.ts` — "payload.tenant_id different from ctx.tenantId", "tenant isolation: a job of tenant A naming a handover of tenant B", "RLS holds for the system actor too".
They fail BEFORE the task runs: `handoverWorld({ s: 'b', status: 'discrepancy', ... })` throws at `__tests__/handovers/world.ts:69` (`seed('homecollection.handovers', ...)`):
`insert or update on table "handovers" violates foreign key constraint "handovers__receiver__fk"`.
Cause: `world.ts:66` sets `received_by_membership_id: RECEIVER.membershipId` for every non-pending handover. RECEIVER is a tenant-A membership; for side `b` the FK (tenant_id, received_by_membership_id) -> core.memberships has no such row in tenant B.
Fix wanted (test side): for `s === 'b'` use a tenant-B membership (e.g. `MEMBER.b`, or the seeded tenant-B staff `01a1a98a-ac40-7000-8000-00000000b500` used in read/confirm tests) as `received_by_membership_id`.
Not a task bug: the other 9 worker tests pass; all 59 API tests pass (read, confirm, static). The 3 tests cannot be judged until the fixture is fixed; the task code (tenant guard `payload.tenant_id !== ctx.tenantId`, tenant-bound repo reads, RLS) is written for exactly these cases.

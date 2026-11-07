# T0B-09 dispute (partial)
Test: tests/db/T0B-09.seeds.test.mjs:68-71 ("every seed is idempotent, owner-role scoped") asserts `SET LOCAL ROLE lims_owner` in ALL db/seeds/*.sql.
Conflict: LD-30 (2026-11-07, binding, overrides spec text; CR-C0-T0B-09 accepted): tenant-scoped seeds (010+) run `SET LOCAL ROLE lims_app`; only class-G seeds 001-003 keep lims_owner. Old rule basis: spec/chunks/C0-foundation-contracts/02-TRD.md §4.6 l.307.
Needed: tester changes the rule to "001-003 lims_owner; 010+ lims_app"; then writer applies LD-30 to db/bootstrap/00_roles.sql and db/tools/gen-seeds.ts.
Not a dispute: the 001 failure itself is a valid test. Blocked on the C0-0C generator fix (.orchestra/cr/T0B-09-001-generator.md).

FD-T08 debug: failure = FK violation order_items__order__fk while seeding `registered + ["not_started"]` (first test of derived.test.ts); no handler code ran.
Likely cause (inferred, not reproduced): orders/helpers.ts:45 registration_no `FDT08-${Date.now()%1e6}-${++seq}` can collide across parallel vitest workers (seq restarts per file); integration/helpers.ts:67 `ON CONFLICT DO NOTHING` swallows the dup order insert, then the item insert hits the FK.
Rerun of tests/frontdesk/FD-T08.pg.sh with no changes: 3 files / 68 tests pass (.orchestra/out/FD-T08-rerun.log). Implementation unchanged; no test edited.
Suggest tester make registration_no unique per worker (e.g. use uid() tail). Not a spec dispute (no spec line involved).

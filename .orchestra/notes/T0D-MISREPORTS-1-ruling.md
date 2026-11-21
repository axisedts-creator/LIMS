TESTS_WRONG — round 3: the 2 rs-c8 snapshot failures are stale .snap files, the implementation stays; per LD-433 the WRITER (not the tester) re-records them.
Verified in this tree (vitest -c src/features/analytics/__tests__/vitest.rs-c8.config.ts): 2 failed / 34 passed — rs-c8.screens.test.tsx "Report hub (tabs)" and rs-c8.screens.admin.test.tsx "New schedule form", both `toMatchSnapshot` mismatches. The round-2 route case (rs-c8.static.test.ts) is now green.
1. The snapshot diff is only the new MIS catalogue rows (Sales representative, Consultant, Repeated patient, Repeated test, ...). They are required by the brief (inbox line 20, items 2-3) and spec/program/08-CR-REGISTER.md:3151 (A39-7: T0D-MISREPORTS-1 owns the catalogue entries and their screens). The .snap files were last recorded in 6c1b8b4c1 (T0D-UIDASH-1), before this task.
2. WRITER (LD-433, rs-cN.*.snap exemption, same as LD-430): from this tree run rs-c8.screens.test.tsx and rs-c8.screens.admin.test.tsx with `-u` and commit both files under apps/web/src/features/analytics/__tests__/__snapshots__. Change no test source and no implementation; do not remove the new rows.
3. TESTER: nothing to do on this point; do not touch the two .snap files.
4. Keep every other rs-c8 case and the rs-c8.baseline.json as they are; rs-c2 must stay unchanged and green (brief, inbox line 20).

=== LEAD ITEM, LD-433 (2026-11-20) ===
Correcting round 2: the ruling told TESTER to re-record the two rs-c8
snapshot files; that is the wrong role, same mistake as the earlier
rs-c4/rs-c6 case (see LD-430). Both snap files match the rs-cN dot star
dot snap exemption, so only WRITER or DEBUGGER may touch them.

WRITER: run rs-c8.screens.test.tsx and rs-c8.screens.admin.test.tsx with
the update-snapshots flag from this tree, and commit both resulting snap
files under apps/web/src/features/analytics/__tests__/__snapshots__. The
new catalogue rows (sales representative, consultant, repeated patient,
repeated test, and so on) are expected content from this task own work;
do not undo them, only let the snapshot catch up to them.

TESTER: nothing further here; the route case point from round 2 is
already fixed and green. Do not touch the two snap files again, they are
not yours on this task.

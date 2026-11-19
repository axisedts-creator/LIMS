TESTS_WRONG — the `worklist` snapshot in __snapshots__/rs-c6.screens.test.tsx.snap:68-83 is stale (it lacks the FilterBar status button `button Ready to release` after `button Search`); the tester must re-record it (`vitest run -u` on rs-c6.screens, under T0D-UILIST-1/LD-362) and commit the .snap; no VG5 implementation change.
Reasons (round 5, 2026-11-19):
1. Round-4 ruling item 2 ordered the `worklist` outline snapshot re-recorded once. 077c743de changed only rs-c6.screens.test.tsx; the .snap at :68-83 still holds the old outline, so :220 fails on the stored baseline, not on the product.
2. The extra `button Ready to release` is the FilterBar status control that the test at :192 itself now clicks (LD-353 template 1, ReportsWorklist.tsx:98). The new markup is required; the stored snapshot is what is wrong.
3. verify.cmd sets CI=true, so vitest will not write a new snapshot; only an explicit `-u` run by the test owner can. The writer may not edit test or snapshot files (brief `files` excludes __tests__).
4. Change: re-record only the `worklist 1` entry; leave the other 3 snapshots (report detail, held, delivery detail) as they are. Keep the snapshot test itself (LD-170 baseline).
5. VG5 implementation (LD-405 tsconfig line) stays. Rest of round-4 items 3-5 still apply.

==== round 4 (kept for the record) ====
TESTS_WRONG — rs-c6.screens.test.tsx:190 and the :214 worklist snapshot assert the pre-UILIST tab bar, which LD-353 no longer requires; the C6/T0D-UILIST-1 test owner must update them; no VG5 implementation change.
Reasons (round 4, 2026-11-19):
1. rs-c6.screens.test.tsx:190 expects `getAllByRole('tab')` = 6. ReportsWorklist.tsx:98 (T0D-UILIST-1, 74ea3e301) replaced the tab bar with one FilterBar status control under LD-353 template 1, a binding lead decision (cited in .orchestra/notes/T0D-UILIST-1-ruling.md:3). The test asserts markup the binding decision removed.
2. Change in the test: replace the `tab` count at :190 with an assertion that the FilterBar status control exists and offers the same 6 statuses (and keep the axe and the one-primary checks). Re-record the `worklist` outline snapshot (:211-215) once, under T0D-UILIST-1/LD-362, as was done for rs-c7 instruments (T0D-UILIST-1-impl.md:2).
3. The fix belongs to the owner of apps/web/src/features/reporting/__tests__ (C6 / T0D-UILIST-1 follow-up), not VG5. The VG5 brief `files` excludes __tests__.
4. These reds were already there before VG5: they fail the same way with the LD-405 tsconfig line reverted (VERIFY-GREEN-5-dispute.md:2). LD-362 (T0D-UILIST-1-ruling.md:5): a task does not fix reds it did not cause. So the 2 rs-c6 reds do not block VG5 if the writer shows they fail the same way before its commit. All other VG5 checks (vg5, web-build-2, the rest of rs-c6) must stay green.
5. The VG5 implementation (the LD-405 line in apps/web/tsconfig.json) stays as the lead ordered. Do not revert the worklist; reverting it would undo LD-353.

==== history (earlier rounds, kept for the record) ====
CR_NEEDED — the spec itself is contradictory/missing
Reasons:
1. The 9 errors sit in apps/portal/src/app/r/[token]/{page,report/page}.tsx. apps/portal is owned by C6 (spec/program/01-CHUNK-MAP.md:143), not C1. The brief's `files` is apps/web/src/** only, so C1 cannot "fix the import" there.
2. The only web-side fix, a `paths` fallback, is in apps/web/tsconfig.json. That file is owned by C0-0D (spec/program/01-CHUNK-MAP.md:132).
3. The errors exist only because a C6 test (apps/web/src/features/reporting/__tests__/rs-c6.portal.test.tsx) pulls the portal pages into the web tsc program. The rs-c6 baseline pins the `@/features/portal/*#sym` and `@/server/*#sym` import keys (rs-c6.baseline.json:126-153). A relative-specifier fix would break those pins, which the brief requires to stay green ("existing tests stay green").
4. vg5.typecheck.test.ts:45 matches the brief text "alias or path wrong -> fix the import", so the test is not wrong on its own terms. But the brief and test require a fix that no file C1 owns can deliver, and CLAUDE.md says "edit only paths your chunk owns". That contradiction is in the spec/brief and needs a CR (spec/program/04-CHANGE-REQUESTS.md:24-38).
5. CR text: .orchestra/cr/VERIFY-GREEN-5.md (options a/b/c). The lead picks one; if the lead accepts deferral, vg5 line 45 must be relaxed by the lead, not by the lane.
6. The writer did not breach any rule: no stub, no tsconfig edit kept, no test edited.

----
LEAD RULING, LD-405 (CR-C1-VG5): picking option (a) from the CR (.orchestra/cr/VERIFY-GREEN-5.md).
This CR has sat unanswered since 2026-11-16; ruling now under LD-310 (pure types/config choice,
no money, data, credentials, schema-outside-task-files or SEC-GATE-1 involved).

Why (a), not (b) or (c): (b) (give apps/portal its own vitest+tsconfig so the test runs from inside
portal) is the architecturally cleanest option but is a new-infrastructure build, not a one-line
fix, and needs C6 (its lane is idle right now, nothing queued to pick this up for a while). (c)
touches apps/portal's own production page files AND the frozen rs-c6.baseline.json import-key pins
-- avoided on the same grounds this session has avoided touching any other frozen baseline. (a) is
one line, in a file C0-0D owns but is not currently using (its queue is idle behind T0D-OFFLINE-4),
touches no frozen baseline, and is fully reversible.

Known downside, accepted and flagged rather than ignored: a paths fallback is program-wide, so it
could in principle let an unrelated future `@/` import in apps/web silently resolve into
apps/portal/src instead of correctly failing as a genuine missing module (LD-250 concern named in
the CR itself). Not treating this as a reason to block a fix that has been stuck 3 days; if it ever
actually masks a real missing-module error, narrow or remove the fallback then, as its own task.

CROSS-CHUNK AUTHORIZATION (this is the one-time supersession, precedent LD-358 pattern): apps/web/
tsconfig.json is normally C0-0D-owned, not C1-owned. This ruling explicitly authorizes C1's own
lane to make this one, narrow edit to that file for this task only, citing LD-405 as the
authorization, rather than waiting on C0-0D's idle queue. Do not use this as a precedent to edit
any other C0-0D-owned file without a separate explicit ruling.

EDIT of apps/web/tsconfig.json -- find the "@/*" entry inside compilerOptions.paths (read the file
first; do not guess its exact current formatting) and change it from:

  "@/*": ["./src/*"]

to:

  "@/*": ["./src/*", "../portal/src/*"]

(adjust bracket/comma style to match the file's existing formatting exactly; do not reformat
anything else in the file). Do not touch rs-c6.baseline.json, vg5.typecheck.test.ts, or any product
file. This should make `turbo run typecheck --filter=@lims/web` pass with 0 non-test errors as
vg5.typecheck.test.ts:45 already requires, with no change to that test needed. If it does NOT
resolve cleanly as expected (e.g. a naming collision between a web file and a portal file under the
same `@/` path), stop and write a dispute rather than forcing it -- do not fall back to (c) or (b)
without a new ruling.

Reset: C1 VERIFY-GREEN-5 to changes.

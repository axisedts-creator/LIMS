# T0D-MSERIES-6 dispute (writer, round 5, 2026-11-16 23:41 NPT, after LD-298)
Tester stage did not run: `git log --full-history -- apps/web/src/features/admin/__tests__/rs-c2.baseline.json` still ends at ec073f164; no diff ec073f164..HEAD.
Verify re-run on HEAD 4cc0e1923: packages/ui 52 passed / 1 skipped; apps/web m6 422/425, 3 reds all in rs-c2.static.test.ts.
Reds 1-2 (data_files, routes): the 3 LD-298 entries (actions.ts, messages.ts hashes; route app/(auth)/auth/waking/page.tsx).
NEW red 3 "same form field names" (line 134): base has `x-forwarded-for`, `x-real-ip`; now lacks them. Cause: c069f7ecd "[writer] T0A-CLIENTIP-1 impl" (merged from main in 2d6aeb827) moved the `h.get('x-forwarded-for'|'x-real-ip')` reads out of features/admin/auth/actions.ts into core/api/client-context.ts (outside the scanned tree). Not an MSERIES-6 change.
So the LD-298 guard ("diff holds only those 3 entries, field_names unchanged") now fails: tester must stop and raise a blocking CR, or the lead must accept the field_names diff (from T0A-CLIENTIP-1) before re-record.
Writer changes nothing (may not edit tests or baseline). ESCALATE TO LEAD.

# T0D-NAV-COMPLETE-1 tests (tester)
Files (apps/web/src): core/nav/__tests__/{vitest.nav-complete.config.ts, nav-complete.helpers.ts, nav-complete.build.test.ts, nav-complete.admin-pack.test.ts}; features/{frontdesk,billing,lab,engagement,payments,catalog}/__tests__/nav-complete.<feature>.test.ts.
Run: `.orchestra/notes/T0D-NAV-COMPLETE-1-verify.cmd` (= `pnpm --dir apps/web exec vitest run --config src/core/nav/__tests__/vitest.nav-complete.config.ts`). Today: 66 fail / 10 pass, for the right reasons (entries, manifests, routes.yaml rows, CR missing).
Rule encoded: entry iff page exists under app/(staff); else NO entry + `.orchestra/cr/T0D-NAV-COMPLETE-1.<n>.nonblocking.md` containing the path and chunk id. Pages missing today: /frontdesk/settings, /lab/worklists, /lab/critical-values, /engagement/settings.
C4 and C5 specs have no permission/group/order columns: permission = API operation floor (openapi x-permission); order = section order [CONV] (frontdesk 10-40; billing 10,15,20,25,30,35,40,45,50, so daily_cash moves 10 -> 20; lab 1-12). Writer may CR a different choice.
Chords not compared; build-nav uniqueness decides. Spec chords collide: payments `g y` (inventory.home), engagement `g m` (instruments.messages): writer picks another or none.
CONFLICT for lead: brief wants Front desk settings in the admin nav, but its page does not exist. Test follows the "only if page exists" rule (absent + CR). Needs a page task for the founder's discount limits.
Admin test writes `.orchestra/notes/T0D-NAV-COMPLETE-1-admin-hidden.md`; corp_admin sees no inventory entries (matrix gap), so only front_desk, billing, catalog, admin groups are asserted non-empty.
Nav labels are not in core/i18n/messages.ts today (shell shows raw keys); label keys only checked by pattern.

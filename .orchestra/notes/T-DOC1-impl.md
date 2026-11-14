# T-DOC1 impl (writer)
- Added `apps/web/src/features/engagement/help/<helpKey>.ts` x12 (plain data, links to `staff.engagement.*` route ids).
- Added `docs/manual/engagement/`: README, bookings, queue, app-access, reminders-memberships-enquiries, settings, how-the-app-protects-your-reports (patient page).
- LD-28 cited in settings.md (legal.privacy_url / legal.terms_url, optional tenant privacy URL) and the patient page (names only, no URLs). LD-140: no colours/sizes in help files.
- [CONV] help file name = full helpKey (as tests assume); `engagement.booking_detail`/`booking_new` link to the bookings route (no separate route id).
- Tests: `node node_modules/vitest/vitest.mjs run --config tests/c16-t-doc1/vitest.config.ts` -> 34/34 pass.
- Open: A6 link to the patient page is Flutter-side (not here); production-build help check (C0-UI 7) not run; no screenshots added.

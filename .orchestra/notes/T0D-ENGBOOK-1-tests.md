# T0D-ENGBOOK-1 tests (tester)
- New: apps/web/src/features/engagement/__tests__/t-b6.engbook1.test.tsx (10 tests; picked up by vitest.t-b6.config.ts). Loaders bookingsPage/slotsPage/bookablePage/bookingNewPage run with serverFetch mocked on real shapes (403 common.feature_disabled; 200 {data:[],page:{limit}}).
- Changed: t-b6.bookings.test.tsx empty-list text "No bookings for this day." -> "No bookings yet" (done_when 2 sets the text; not a weakening).
- Run: `.orchestra/notes/T0D-ENGBOOK-1-verify.cmd` (t-b6 + t-q4 + t-l1 + adminpage-eng-1 configs, apps/web).
- Now red (10): feature-off pages throw ApiError 403 (root cause: listBookings/listTemplates/listBlackouts/listBookableItems are unguarded, error.tsx shows Something went wrong); empty text is old; no table-vs-message split.
- Already green on purpose: 200 empty list renders (no crash); 500 must still throw; side-call 403 must not crash.
- Contract the writer must meet: message "Bookings are switched off for this lab" (slots/bookable: text matching /switched off for this lab/); link name /engagement settings/ -> /engagement/settings only if session has engagement.settings.manage; GET-only, no settings call.
- Not testable here: real Render/API; whether the API gates S1 (code shows S1 does not, so which call returns 403 live is unconfirmed).

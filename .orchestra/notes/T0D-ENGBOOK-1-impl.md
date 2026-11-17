# T0D-ENGBOOK-1 impl (writer)
- Root cause: with an engagement feature switched off the API answers 403 common.feature_disabled; listBookings / listTemplates / listBlackouts / listBookableItems were unguarded in server/booking-pages.tsx, so the throw reached error.tsx ("Something went wrong"). Side calls (centres, cancel reasons, queues, patient names) already caught.
- Changed: server/booking-pages.tsx — orOff() maps ONLY ApiError 403 common.feature_disabled to a plain "Bookings are switched off for this lab" page (bookings, slots, bookable); link "Open Engagement settings" -> /engagement/settings only with engagement.settings.manage. Any other error still throws (error page + reference).
- Changed: components/BookingsList.tsx empty text -> "No bookings yet" (headers already stay visible via DataTable).
- [CONV] plain <a href> instead of EmptyState action (action needs a client onPress; page is a server component). Slots/bookable pages use the same "Bookings are switched off" wording (bookings feature gates them).
- No settings read or written; no route, permission or rs-c2.static file touched.
- Tests: t-b6 104/104, t-q4 82/82, t-l1 35/35, adminpage-eng-1 80/81 — the 1 red is pre-existing (permissions.yaml byte-diff vs. baseline, changed by T0C-ACCT-1 db5fcccda), unrelated.
- Open: which live call returns 403 (S1 may not gate) unconfirmed on Render; tsc shows pre-existing msw `onUnhandledRequest` type errors in engagement tests, none in changed files.

# T0D-UIGUARD-1-ENGAGEMENT tests (tester)
Run: `.orchestra/notes/T0D-UIGUARD-1-ENGAGEMENT-verify.cmd` (build:nav, the uiguard1 guard config, then the engagement states config).
1. Registry (LD-441 step 1): deleted all ENGAGEMENT entries from `apps/web/src/core/__tests__/uiguard1.exceptions.ts` (rule 2 x3, rule 4 x4, rule 7 x9). No entry re-added. Guard now red: rule 2 (EnquiriesView, RemindersView on 3 routes), rule 4 (4 routes), rule 7 (9 routes: BookingDetail/BookingNew/SlotsAdmin, ProfileImages, EnquiryThread, Broadcasts, SettingsView).
2. WRITER: delete the 16 ENGAGEMENT lines (7 rule 2/4, 9 rule 7) from `notes/T0D-UIGUARD-1-exceptions.md` (sections "T0D-UIGUARD-1-ENGAGEMENT" rule 2/4 and rule 7); the guard's notes-mirror test needs them gone. Tester may not edit notes/.
3. New `features/engagement/__tests__/uiguard1.engagement.states.test.tsx` (+ `vitest.uiguard1-engagement.config.ts`): renders the 4 pages with only serverFetch faked. 501 operation_pending -> NotAvailable, 500 -> ErrorState (title, Reference, Retry refreshes), no request id, no permission -> notFound without an API call. Red today: pages rethrow (12 fail).
4. Regression (green now, must stay): thread 404/400 -> notFound, malformed id -> notFound, 403 still rethrown.
5. Existing `uilist3.engagement.*`, `t-n1`, `t-r2` tests pin the old markup only where the writer changes it; the writer edits those, not me.
Not tested: pixel match to the Worklist mock (no browser here), rs-cN snapshots (writer re-records, LD-440), rule 7 rendering beyond the guard's source walk.

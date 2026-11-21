# T0D-UIGUARD-1-ENGAGEMENT impl (writer)
1. Rule 2: EnquiriesView, RemindersView use kit FilterBar ("Clear filters"); reminders range = FilterBar date_range "Due date range" with maxDays 92 (kit DateRangePicker shows the order / 92 days error). [CONV] an incomplete or invalid range keeps the applied URL range; same query = no navigation.
2. Rule 4: enquiries, enquiry thread, memberships, reminders pages wrap the read in core/shell loadOr (501 NotAvailable, 5xx ErrorState, table headers kept); thread 404/400 still notFound, 403 still thrown.
3. Rule 7: Card title rows replace raw h2 (SlotsAdmin x2, BookingDetail History + Booking, Broadcasts history); raw ul replaced: thread messages = Card + kit Timeline, chosen tests / profile hits = role=group, sample / settings messages / booking tests = text lines.
4. Kit additive props (LD-441): FilterDef date_range `maxDays?`, Timeline `aria-label?`. tokens.json, kit.css, shell.css untouched.
5. notes/T0D-UIGUARD-1-exceptions.md: 16 ENGAGEMENT lines + their 2 empty headings deleted. Registry untouched.
6. Writer changed no test. t-r2 range helper (tab out after typing; kit DatePicker commits on blur) was fixed by the TESTER in 4a7d96110 (review item 1). No rs-cN snapshot covers engagement; none re-recorded.
7. Green: uiguard1 guard 36/36, t-r2 33/33 (after tester fix 4a7d96110), engagement states 20/20, t-n1, t-m1, t-b6, msgdesk1, content1, adminpage-eng-1, t-l1, t-q4, uilist3, uiset1, web tsc (non-test). packages/ui: 7 failures pre-existing (fonts, density, no-raw-style in other areas' files).
8. Open: pixel match to the worklist mock not verified in a browser; ui-r03-kit-pass .snap shows as modified (CRLF only, empty diff) after the kit run, could not restore from this shell.

# T-BK1 dispute — a19_addresses_test.dart:33 ("A19 lists ... empty -> LimsEmptyState")
Test defect, not implementation. Line 40-41: `api.addresses = []` then a second `pumpWidget(bookingsScope(...AddressesScreen()))` on the same tester.
Same widget types/keys at same tree position -> Flutter updates the existing element; `_AddressesScreenState.initState` (addresses_screen.dart:34-37) does not rerun, so E37 is not refetched and the stale rows stay -> 0 `LimsEmptyState`.
Impl matches spec: empty list renders LimsEmptyState (addresses_screen.dart:102); 04-UI-UX.md §A19 / line 146 require address list + [Add address], no contrary rule.
Fix needed in test (not allowed for debugger): unmount between pumps (`await tester.pumpWidget(const SizedBox())`) or give the scope a fresh `key`, or set `api.addresses = []` before the first open in a separate testWidgets.
Other 75 tests pass. Stopping; no impl change.

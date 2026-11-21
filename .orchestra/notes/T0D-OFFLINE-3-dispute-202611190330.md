# Dispute T0D-OFFLINE-3 (debugger round 14)
Tests contradict LD-140/LD-310/LD-400 ruling (TESTS_WRONG), not the implementation. Verify 03:03 failures only in apps/web/src/features/frontdesk/__tests__/:
1. rs-c4.static.test.ts:75 frontdesk_feature server_symbols_added is non-empty: 32 symbols from already-landed REGSCREEN-2 (drafts, favourites, ICD codes, patient rewards, numbers preview, CustomFieldDefinition, ReceiptDocument, getPatient, listCatalogOptions). Not in LD310_ALLOW.
2. rs-c4.screens.test.tsx Daily cash (open shift) snapshot: UIDASH-1 header status block + stat row/chart card; snapshot still old.
OFFLINE-3 touches none of these. Per LD-400 a further trip needs a structural decision (regex/pattern for server_symbols_added, snapshot re-record with -u by the tester), not another list patch. Debugger may not edit tests.

# Dispute T0D-OFFLINE-3 (debugger round 13)
Tests contradict LD-310/LD-400 ruling (TESTS_WRONG), not the implementation. Verify 02:42 failures are only in apps/web/src/features/frontdesk/__tests__/rs-c4.static.test.ts (x2) and rs-c4.screens.test.tsx (Daily cash snapshot).
LD-400 says the lead edited rs-c4.signature.ts / rs-c4.static.test.ts / the .snap directly, but C0-0K does not have them: rs-c4.signature.ts:113 still `route_strings_added: ['/v1/catalog/tests']`; rs-c4.static.test.ts:78 uses .includes and :90 asserts toHaveLength(1); permissions allow-list lacks frontdesk.patient.read.
Needed: re-apply LD-400 edits (permission frontdesk.patient.read, route_strings_added regex, Daily cash snapshot) in C0-0K and commit. Debugger may not edit tests.

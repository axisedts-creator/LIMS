# T0B-TESTFIX-2 dispute (debugger): test defect, not product defect
Spec/brief line: task done_when (3): "each test file that changes tenant settings ... restores the settings in a finally block" (LD-314).
Test: services/api/src/modules/frontdesk/__tests__/probes/uploads.live.test.ts:48 `it.each(OPS...)` sweeps all operations incl. updateFrontdeskSettings (kit.ts:214, if-match "1"). It succeeds and changes tenant A settings (sms off, autoprint off, min chars 4) and is never restored, so search.test (2 tests) and registration.test (3 tests) fail.
Debugger may not edit tests; no product change is correct. Tester must restore the baseline (admin/helpers resetSettings in afterAll) in uploads.live.test.ts, or use a stale if-match for that one op in the sweep, then re-run the suite 3 times.

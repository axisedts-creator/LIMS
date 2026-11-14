# WIRE-REP dispute (debugger)
- Verify fails only in reporting/__tests__/manifest.test.ts "501 stubs in dev" (4 tests: getPortalDues, createPortalPaymentRequest, getPortalPaymentRequest, no-echo).
- Cause: those 3 ops are implemented in handlers/portal.handlers.ts (C6 lane, merged from main) but missing from __tests__/implemented-ops.ts (line 16 lists only P1-P6), so the test still expects 501 (manifest.test.ts:70-71 says each task must add its ops there).
- WIRE-REP diff (0c5151e7~3..HEAD) touches only index.ts ports, config.ts, renderPort.lazy.ts and its own test. Failure is pre-existing and not caused by WIRE-REP.
- Fix needs a test-support edit (add the 3 ops to IMPLEMENTED); debugger may not edit tests. Tester/C6 owner to do it.

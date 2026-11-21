Title: CR-C0-T0B-PROVFIX-2-001: request_failed log line carries only err_name; add err_message and first stack line for native errors
From chunk: C0 (lane C0-0B, task T0B-PROVFIX-2, LD-295)   To owner: core (services/api/src/core)
Type: logging (core/errors.ts)
Blocking? NO

Problem: services/api/src/core/errors.ts:130 logs { event: 'request_failed', error_code, err_name } only. The live staging fault of
 2026-11-16 22:19 NPT (inviteTenantAdmin, reference 01a1e536-07e9-7fc1-a3da-b10e93bd9b18) showed only "TypeError"; the cause
 (s.now.getTime is not a function, tenant.service.ts guard) had to be found by a real-chain test.
Proposed change: when err is a native TypeError, RangeError or ReferenceError (not a pg DatabaseError, not a LimsError),
 add err_message (err.message) and err_stack0 (the first "at ..." line of err.stack). Never for database errors (REQ-SEC-026).
Backward compatible? yes (additive log fields).
Tenant/security impact: native error messages from our code only; no SQL, no row values. Database errors keep err_name only.
Tests that will prove it: core/errors test: a thrown TypeError logs err_message + err_stack0; a pg error (code 42501) logs neither.

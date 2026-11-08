# BL-T15 dispute (writer)
Tests wrong: `services/worker/src/jobs/billing/__tests__/export.render.test.ts`, 3 cases that can never pass for ANY implementation:
1. `export_render guards ... payload null` and `payload undefined` (it.each, ~line 184): `run()` (line 73-76) calls `task(o.payload ?? { tenant_id: TENANT_A, export_id: JOB }, ...)`; `??` turns `null` and `undefined` into the VALID payload, so the task correctly renders and runs statements; the test then expects `stmts` to be `[]`.
2. `export_purge ... payload undefined` (it.each, ~line 233): `go(w, payload: unknown = { tenant_id: TENANT_A })` (line 206) - a default parameter replaces `undefined` with the VALID payload, so the purge correctly runs; the test expects no statement.
Proof: the same guard passes for `{tenant_id: TENANT_B}`, `{}`, `{tenant_id}`, `{export_id}`, a bad uuid and (purge) `null`; the guard code is `typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || ...` in export_render.ts / export_purge.ts, which also resolves with zero statements for real `null`/`undefined` payloads.
Fix (tester): pass the payload through unchanged, e.g. `'payload' in o ? o.payload : default` in `run`, and a sentinel/arguments.length check in `go`. Writer did NOT edit the test.
Result with the other 118+ tests of the worker + all 1396 api billing tests: green. Only these 3 fail.

TESTS_WRONG — round 2: `refused()` attaches its rejection handler too late, which causes vitest's "Unhandled Rejection" errors. Change the test helper; the implementation stays.
1. ack.test.ts:130-132. Each caller evaluates `ack(...)` before calling the helper (lines 142, 151, 152, 157, 162, 163). The helper then awaits `deviceRow(d.id)` (line 131) and only after that calls `p.then(...)` (line 132). A4 rejects during that wait, so Node reports the rejection as unhandled. The run log shows 84/84 passed with "4 errors" (HC-T11-impl-run.log:38,130-131), so vitest exits non-zero.
2. The spec only requires that these calls are refused and leave no state change: 07-SECURITY.md:75 (AB1 -> 409 homecollection.device_not_registered) and 02-TRD.md:206 (A4 needs homecollection.sync.upload). Nothing in the spec says when the promise rejects relative to DB I/O, so refusing before any DB read is compliant.
Change: make the first statement of `refused` `const settled = p.then(() => { throw new Error('expected rejection'); }, (x: any) => x);`. Then read `before` and do `const e = await settled;`. Alternatively, change the helper to take a thunk `() => ack(...)` and call it after `before` is read, updating every call site.
Keep all codes, statuses and the before/after `frozen(deviceRow)` equality checks unchanged.
Done when: the suite reports 0 errors and exits 0.
No CR needed.

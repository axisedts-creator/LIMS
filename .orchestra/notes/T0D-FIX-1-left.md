# T0D-FIX-1 left over (tester, needs a lead decision)
DONE_WHEN (6) says no handler under modules/ may call .getTime()/.toISOString() on ctx.now(). The scan finds 80 older sites in 31 files outside this task's files
(per-file counts in services/api/src/core/__tests__/fixtures/ctx-clock-baseline.json): lab write paths (specimen, result, signoff, qc, critical, label, ingest,
exception, order, stores), micro (culture, report, isolate, instrument-record), frontdesk (order, registration, parity, patient, discount), anatomic (7 files), identity (auth, user),
homecollection snapshot, catalog CatalogPort.impl. That is far over the 16 file cap, so item 6a is strict only for the task's own files and a RATCHET (count may only fall) elsewhere.
Some of these may be safe if their own deps clock returns a Date (not verified per site). Options: (1) a core fix: ctx.now() returns a Date-like that also has toISOString/getTime
(one change in core/pipeline/index.ts, then the baseline can be emptied), (2) one follow-up task per module. The scan counts uses of the clock result; it does not prove runtime failure.
Not covered by tests: chain.service.ts:210 and culture.service.ts:129 nowOf users (getCulture paths) beyond the strict scan; lab write paths at runtime.

# C6-T11 dispute (writer)
2 of the C6-T11 tests are wrong: both pass `undefined` into a parameter that has a JS default, so the default is used and the case under test never happens.
1. `narrative-image.handlers.test.ts:30/141` — `up = (c, body, narrativeId: unknown = NARR_1)`; case `['undefined', undefined]` calls `up(..., undefined)` -> narrativeId = NARR_1 (valid draft narrative) -> 201, so `rejection()` throws "expected rejection, got success". Service does reject a missing id (`typeof narrativeId !== 'string'` -> common.not_found).
2. `process_narrative_image.test.ts:15/90` — `setup(row, bytes = CLEAN, ...)`; `setup(imageRow(), undefined)` -> bytes = CLEAN, the object IS stored, so the worker correctly goes `ready`. With a truly missing object `storage.read` throws before any state move (row stays pending_scan, job retries).
Fix (tester): call `manifest.handlers[N6]({ params: { narrative_id: undefined } ...})` directly / use `null` sentinel; in setup use `bytes: Uint8Array | null` and pass `null`.
All other tests pass: api reporting 617/618, worker reporting 64/65 (only these two fail).

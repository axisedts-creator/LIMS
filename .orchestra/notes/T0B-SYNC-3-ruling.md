TESTS_WRONG — the test double forwards the wrong argument; change services/api/src/core/sync/__tests__/adapters/doubles.ts:101-102 to `behave.collect(ctx, a[0])` and `behave.receive(ctx, a[0])`. No assertion changes.
Reasons:
1. Spec: collectSpecimen / receiveSpecimen take `specimen_id` as the PATH parameter (spec/chunks/C5-lab-workflow/02-TRD.md:216, :219), i.e. the params argument, not headers.
2. The real service signature is `(c, params, headers, body)` (services/api/src/modules/lab/service/specimen.service.ts:273-274) and the tester's own pinned surface says the same (doubles.ts:10).
3. With `...a` capturing everything after ctx, `a[0]` = params, `a[1]` = headers. The tester's green assertion at lab.live.test.ts:38 confirms this: `args[0]` ~ `{ specimen_id }`, `args[1]` ~ `{ 'if-match': '"2"' }`.
4. `moves()` (lab.live.test.ts:25) reads `params.specimen_id`; given headers it gets undefined -> TypeError -> common.internal. The failure is a double defect, not adapter behaviour.
5. The fix only routes the already-recorded params to the behaviour; the expectations at lab.live.test.ts:76-78 and the twin at :141 stay exactly as written (accepted, then duplicate, service ran once). Nothing loosened.
6. Default behaviours (doubles.ts:87-88) also read `params.specimen_id`, so a[0] is correct for them too (they only wrote a wrong entity_id in the effect row before).

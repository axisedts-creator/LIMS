LEAD ITEM, LD-427 (2026-11-19, rewritten after rounds 3, 4 and 5 did not land it):

Background: arbiter ruling 757347041 already fixed the over-asserting gate (allowlisted
sec-hyg1.pollers.test.tsx, re-baselined as-any to 80); the tester already committed that part
(85aabebfd). What is left is test-only and has not been committed in three identical debugger
rounds.

TESTER: this is for you, not the writer. Apply these two items now, as your own test-file edit,
in this review-fixes pass:

1. Run tsc -p apps/web --noEmit (or your own typecheck task) and find every TS2883 error located
under apps/web/src/__tests__ in a file matching star.harness.tsx, star.helpers.tsx, or
rs-c15.fixtures.tsx. There are 65 of them per the last three debugger rounds. Each is an exported
function or const whose return type TypeScript cannot name on its own (a router, a navigationMock,
a show or wrap helper, or similar, typically returning a vitest or testing-library type). Add an
explicit return type annotation to each one. This is a type-only, test-helper-only change: no
runtime behavior changes, no assertion changes, no product file touched.

2. Compare the current count of the literal text as any under apps/web/src (excluding the vgN
typecheck guard files, same exclusion the gate itself uses) against the approved baseline of 80.
The debugger log says this task added about 10 over that baseline. Find exactly which as any
casts this task itself added (not any of the pre-existing 80) and replace each one with a narrow
typed cast instead. Do not touch any pre-existing as any cast outside this tasks own edits.

After both items, confirm tsc -p apps/web shows zero TS2883 errors in the harness, helper and
fixtures files named above, and that the as any count under apps/web/src (same exclusion) is at
or under 80, before committing.

WRITER: there is nothing for you to do on this task right now. Both remaining items are
test-file-only (declaration-emit type annotations and cast narrowing inside test helpers); a
writer commit to these files does not survive Enforce and only wastes a round. If after the
tester commit above tsc still reports a non-test-file error, or a product-code error appears,
that is new information and belongs in a fresh debug round; otherwise wait for the tester.

Reset: C1 VERIFY-GREEN-8 to changes.

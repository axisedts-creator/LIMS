TESTS_WRONG — dispute 3: rs-c4.screens.test.tsx snapshots "Register: blank" (:37), "Register: returning patient, one test, quote and summary filled" (:42), "Register: new-patient form open" (:57) depend on wall-clock time. Earlier rulings (1, 2) stay in force.
Change in the test (tester-owned, apps/web/src/features/frontdesk/__tests__/rs-c4.screens.test.tsx):
  Freeze Date for the three Register snapshot tests only: in a beforeEach/afterEach scoped to them, `vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-17T06:00:00Z'));` and `vi.useRealTimers()` after. Fake only Date (not setTimeout), so react-aria/user-event async paths are unaffected. Then re-record those 3 snapshots. Do not add a regex normaliser for the timestamp (it would hide a wrong format); do not change any other snapshot or assertion.
Reasons:
- Task brief done_when (2) (inbox T0D-REGSCREEN-1, LD-310) requires "registration date and time shown read only"; regscreen1.items.test.tsx:7 and :99 pin it as value = now in Asia/Kathmandu. The implementation is therefore required to put the current time in the DOM.
- rs-c4.screens.test.tsx:18-21 normalises only ids, and the file has no vi.setSystemTime/useFakeTimers (grep), so a snapshot taken at 11:58 cannot match at 12:44. The only diff is that value attribute (dispute note :2). A snapshot that fails by time of day asserts nothing the spec requires.
- The writer must not hide the time from the DOM to satisfy the snapshot: that would bend done_when (2). No spec conflict, so no CR.
- Parallel-run 20 s timeouts (dispute note :5) are not ruled here: suites pass alone; not a test-correctness issue.

--- Prior ruling (dispute 2, kept for reference, still in force) ---
TESTS_WRONG — dispute 2: items 1, 3 and 4 test-side; item 2 (regscreen1.quickadd.test.tsx:158 `quick_add: true`) stays as written and red until C3 adds `quick_add: bool` to DOCTOR.create (C3 03-APP-FLOW.md:137, 02-TRD.md:281; apps/web/src/features/catalog/server/specs.ts is C3-owned, 01-CHUNK-MAP.md:161).
  1. fd-t13.states.test.tsx :446/:460/:549 open the `More` fold first; no LD-25 assertion changes.
  3. regscreen1.quickadd.test.tsx:285 use userEvent.setup({ delay: null, applyAccept: false }) instead of the per-call option.
  4. regscreen1.items.test.tsx:86-95 pick the patient before adding CBC; keep both centre_id assertions.

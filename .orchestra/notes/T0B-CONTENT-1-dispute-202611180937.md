# T0B-CONTENT-1 dispute (debugger, 2026-11-18)
Only failing test in verify (2244 pass / 1 fail): `src/core/__tests__/pending-operations.test.ts:293` module reporting: expected pending `[listPrintProfiles, listSignatoryProfiles, previewPrintProfile, upsertPrintProfile, upsertSignatoryProfile]` to equal `[]`.

Not a CONTENT-1 defect. Engagement is green (content1.pending 5/5, markdown + static 39/39). The failure is in `modules/reporting/index.ts`, not an owned path.

Two tests contradict each other for reporting:
- `core/__tests__/pending-operations.test.ts:292-293` (T0B-BOOTGATE-1): pending must equal the spec ops whose `manifest.handlers[op]` is not a function. Reporting fills every op with a 501 stub function (`index.ts:36-39`), so lacking = [] and pending must be [].
- `modules/reporting/__tests__/contract/printcfg1.pending.test.ts:36-44` (T0C-PRINTCFG-1, LD-325(b), LD-335): the five PRINTCFG ids must have a manifest entry (line 38) AND be in pendingOperations while they are 501 stubs (line 39), and only those five may be pending (line 43).

No reporting/index.ts content satisfies both while the stubs exist. Fix belongs to T0B-PRINTCFG-1 (real handlers, then drop the five ids from pending) or to the lead (relax one test, or stop stubbing pending ids in reporting). I did not edit tests or reporting.

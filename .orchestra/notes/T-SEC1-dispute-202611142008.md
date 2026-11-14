# T-SEC1 dispute (writer)
Test: operations.matrix.test.ts "none is still the T-01 placeholder" fails for listMyProfiles (E13), updateMyProfile (E18), removeMyProfile (E19), listFollowUpSuggestions (R4).
Why disputed: no plan row owns these API handlers. T-L6 (E13/E18/E19) is app-only, files `features/profiles/**`; R4 is "when T-P4 exists" (T-R2/T-P4) and T-P4 shipped without it. T-SEC1 owns only `__tests__/probes/**`, so a probe task cannot gate on four unplanned backend handlers.
Not fixed by writer: implementing them needs new service+repository code (links, profile shape, If-Match, link-limit rules) with no task, tests or owner; that is a plan gap, not a T-SEC1 change.
Ask: lead either adds plan rows (backend E13/E18/E19; R4) and keeps the test, or relaxes the test to an explicit allow-list of those four ids until those rows land.

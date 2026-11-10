# C6-T31 impl (writer)
Files: app/(staff)/reporting/{page,loading,error}.tsx + 9 sub-pages + 3 PDF proxy route.ts; features/reporting/{components/* (11 new), help/*.md (10), nav.manifest.ts, server/pdf.server.ts}; read/write.server.ts typing + previewTemplate now sends the required {variant}.
Result (after ruling C6-T31, tests revised): 200/200 pass, 0 unhandled errors (`--maxWorkers=1`); tsc clean for reporting non-test files (remaining tsc errors are pre-existing: missing core/nav/generated, @lims/ui css). Parallel run on this machine hit vitest "Timeout waiting for worker to respond" (env load, not code). ESLint not installed — not run.
Post-ruling fix: OutsourcedQueue upload now catches non-ApiError transport failures and shows a form error (was an unhandled rejection: "fetch failed / RequestContentLengthMismatchError" from jsdom File through undici in tests).
[CONV] native `<select>` (ReasonDialog/NativeSelect) instead of kit ConfirmDialog's react-aria Select for reason dialogs; NumberInput/SimpleTable (native table + caption); Timeline replaced by a plain ordered list.
[CONV] PDF links go through same-origin proxy routes (browser never holds the token); outsourced link maps to GET /outsourced-files/{id}/content.
LD-70: no API stubs became real handlers in this task (web only) → pending.json untouched.
Review #1 fixed: invented `latest_version_id` removed; UI selects report ids, bulkReleaseAction resolves each via getReport to its newest `rendered` version id (cap 200), results mapped back to report ids; reports without a rendered version count as "not released". CR .orchestra/cr/C6-T31.md no longer needed. Re-run: 200/200 pass, tsc clean for reporting.
[CONV] bulk resolve = N GET /reports/{id} calls (≤200) per bulk release; switch to a contract field if one is added.
Open: next.config serverActions.bodySizeLimit must allow 15 MB uploads (not owned); centre-contacts read-only; preview/print polling and E2E not covered by tests.

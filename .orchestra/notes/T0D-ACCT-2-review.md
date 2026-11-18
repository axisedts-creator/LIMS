APPROVE

Re-review after f074db540 / acf03f6fa. Prior finding 1 fixed: DailyCollectionScreen.tsx:46-48 blocks Save with `billing.daily_summary.reason.search_first` while the Lab/Day controls differ from the loaded summary (centreId/day props); after Search the props match the local state, so Save re-enables. New test (acct2.screens.test.tsx, "Save is blocked while the Lab or Day controls differ…") covers both centre and day changes and asserts no POST; catalogue key added to messages.ts and pinned in acct2.source.test.ts.

Checked, no defect (unchanged from first pass): operation paths, params, permission codes and limits match contracts/openapi/billing.yaml and contracts/permissions.yaml; no new permission code; Idempotency-Key on writes, If-Match on expense-type PATCH; no PATCH/DELETE on expenses or transfers (LD-313 b); Accept confirm step; double submit guarded; no logging/PHI/secrets; owned paths only (17 code files, none under features/admin, features/platform, app/(auth), app/(platform)). No DB/RLS in this task.

Runs: `.orchestra/notes/T0D-ACCT-2-verify.cmd` 10 files, 268/268 pass. tsc: only acct2.screens.test.tsx:108 (`onUnhandledRequest` typing, same as existing t23 test), none in implementation files.

For the lead (not defects): accept/reject remark not sendable (contract has no body); Received tab = to_id = me only; BANK_DEPOSIT particular not seeded, deposit stays blocked until finance creates it (LD-313 e); fractional nav orders 51.2-51.8 need lead confirmation.

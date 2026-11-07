APPROVE
## C3-catalog-pricing (lane/C3)
# T-01 review (reviewer, chunk C3-catalog-pricing) — diff 8d7ad21..a5fe3ef
- Diff scope: `services/api/src/modules/catalog/__tests__/probes/pending.json` (new, 107 entries) + `.orchestra/notes/T-01-impl.md`. Both owned/allowed paths; pending.json is listed in the task brief files.
- pending.json is now tracked in git (`git ls-files` confirms), so the earlier ENOENT problem cannot come back.
- Names: skeleton.test.ts:125 checks every entry is an operationId in contracts/openapi/catalog.yaml with no duplicates; :133 checks the list equals exactly the handlers that still throw common.service_unavailable/not_implemented. Nothing invented.
- No PHI, no secrets (plain operationId strings). RLS/permissions/idempotency/rate tier: no code change in this diff.
- Ran: `npx vitest run src/modules/catalog` = 1 file, 47/47 pass.

## C5-lab-workflow (main)
Scope: `git diff 394c323..HEAD` (core/openapi.ts AJV keywords, 3 test fixes per ruling, notes).
- `AJV_OPTIONS.keywords = ['x-coded-set']` matches lead AUTO 2026-11-07T19:16:21 exactly: strict + `removeAdditional:false` unchanged, no `x-extensible` (absent from every contracts/openapi/*.yaml), no `strictSchema:false`. Annotation-only per 02-CONVENTIONS §5.5. Inherited by BODY_/RESPONSE_AJV_OPTIONS. Edit outside C5 ownership is authorised by that decision and cited in a comment.
- Test changes match ruling items 1-3. Nothing weakened: the 401 + `auth.*` and 404 assertions are kept, the regex only widens to 2-segment names, and the timeouts are a harness limit.
- No new names, PHI, secrets, RLS or DDL in this diff.
Verified: api `src/modules/lab` 73/73; worker `src/jobs/lab` 5/5; api `tsc --noEmit` clean.
Non-blocking, for the lead (ruling #5, C0): the full api suite is 11 failed / 1334 passed. Causes are `module lab: bearerJwt operations need LIMS_CORE_JWT_* config` and 5000 ms timeouts in core tests that autoload the real modulesDir. `core/__tests__/openapi.test.ts` passes alone (9/9), so the AJV change did not cause these. Fix belongs to C0 test config, not C5 paths.

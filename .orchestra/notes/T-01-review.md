APPROVE
Scope: `git diff 394c323..HEAD` (core/openapi.ts AJV keywords, 3 test fixes per ruling, notes).
- `AJV_OPTIONS.keywords = ['x-coded-set']` matches lead AUTO 2026-11-07T19:16:21 exactly: strict + `removeAdditional:false` unchanged, no `x-extensible` (absent from every contracts/openapi/*.yaml), no `strictSchema:false`. Annotation-only per 02-CONVENTIONS §5.5. Inherited by BODY_/RESPONSE_AJV_OPTIONS. Edit outside C5 ownership is authorised by that decision and cited in a comment.
- Test changes match ruling items 1-3. Nothing weakened: the 401 + `auth.*` and 404 assertions are kept, the regex only widens to 2-segment names, and the timeouts are a harness limit.
- No new names, PHI, secrets, RLS or DDL in this diff.
Verified: api `src/modules/lab` 73/73; worker `src/jobs/lab` 5/5; api `tsc --noEmit` clean.
Non-blocking, for the lead (ruling #5, C0): the full api suite is 11 failed / 1334 passed. Causes are `module lab: bearerJwt operations need LIMS_CORE_JWT_* config` and 5000 ms timeouts in core tests that autoload the real modulesDir. `core/__tests__/openapi.test.ts` passes alone (9/9), so the AJV change did not cause these. Fix belongs to C0 test config, not C5 paths.

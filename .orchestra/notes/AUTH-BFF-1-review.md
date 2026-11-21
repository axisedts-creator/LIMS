APPROVE

# AUTH-BFF-1 review (reviewer, 2026-11-15)

Diff 6badc3d8..HEAD: 6 code/test files + 4 .orchestra notes/cr files.

## Scope (LD-206 REVIEW item)
- Code touches only core/module.ts, core/pipeline/index.ts, core/openapi.ts, and pipeline/__tests__ (new bff-key.test.ts; MEMBERS in stage08-handler-context.test.ts and pipeline.integration.test.ts). Within the 8-file limit. Nothing outside SCOPE. No verifier, claims-resolver, endpointFamilyOf, identity module or handler edit.
- The diff adds NO new way to read a key. openapi.ts wrap() passes `bffKey: ra?.bffKind`, the existing createBffKeyVerifier result from onRequest (openapi.ts:126). No header, body, query, cookie, env or JWT read was added. pipeline buildCtx copies `c.bffKey` into the frozen ctx (index.ts:116, Object.freeze) as an own key that is undefined when absent.

## Checklist
- Names: `bffKey`, `BffKind`, `X-Lims-Bff-Key`, `auth.login_failed` match LD-206 and 08 R10/A13 D-32. HandlerContext member is `readonly bffKey?: BffKind | undefined`. BffKind = 'staff_web'|'partner'|'portal', the same as the lead's TRD 6.3 amendment.
- RLS, permissions, idempotency, rate tier: no change and none needed (no table, route or permission added). The test probe ops exist only in the test.
- No PHI or secrets. Keys are synthetic in-test strings in a tmp dir. No key appears in a test title or assertion message. Email is example.invalid.
- Tests cover done_when: staff_web, partner and portal headers give the right kind. These give undefined: absent, empty, wrong, +1 char, case change, Authorization, cookie, kind name, over-long header, query field, body field. Also covered: an empty key file fails closed, no cross-request leak, and ctx is frozen. The real loginStaff with no ctx wrapper reaches GoTrue with staff_web. Without the header it returns auth.login_failed and never calls GoTrue. Partner, portal, wrong and empty keys are refused. The refusal body does not reveal the bff check. Both MEMBERS lists include bffKey.
- CR note to C0 (T0D-18) filed as LD-206 requires.

## Checks run by reviewer
- `vitest run src/core/pipeline/__tests__ src/modules/identity src/core`: 6214 passed, 1 failed, 102 skipped. The failure is identity role-packs/route-guard.test.ts (AppShell nav). It already existed and LD-206 places it out of scope.
- `tsc --noEmit`: no errors in core/module.ts, core/openapi.ts or core/pipeline.

## Not verified
- pipeline.integration.test.ts MEMBERS: DB-backed, skipped (no LIMS_TEST_DATABASE_URL).
- Web BFF side (Vercel LIMS_WEB_BFF_KEY = Render lims-bff.key, LIMS_CORE_ENV=staging): founder-only per LD-206.

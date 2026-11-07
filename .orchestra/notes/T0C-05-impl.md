# T0C-05 impl (round 3: review items 1-2 test-only, fixed by tester 2463706; no impl change) — tools/codegen 176 pass/3 skip; contracts 250/250
- Files: tools/codegen/{codegen.ts,gen-permissions.ts (LD-01 patient exception),gen-access-actions.ts}, lint-openapi.ts, package.json; generated outputs in contracts/ports/generated/, packages/api-client-{ts,dart}/, db/seeds/00{1,3}_*.sql, shared-ts routes, shared-dart .g.dart (02-TRD §5.3 hand-off paths).
- Round 2: contracts/package.json "exports" for ./ports/common and ./ports/generated/error-codes (LD-03); contracts/ports/common.ts LimsError: no parameter properties, fields declared, assigned in the constructor (LD-03); ERROR_META already emitted.
- [CONV] LimsError assigns safeDetail/fieldErrors only when defined (exactOptionalPropertyTypes).
- [CONV] generateAll is sync: in-house schema→TS (openapi-typescript-shaped), client.ts on openapi-fetch 0.17.0, Dart client dependency-free over `LimsTransport`.
- [CONV] C4 → frontdesk+billing consumers; "all" = every module except owner; g_permissions.module = first code segment, phase '1'.
- Dispute: 2 T0C-02 ports.test.ts assertions require the parameter-property form that LD-03 forbids.
- Open (0A): api-client-ts package.json + lock, root `pnpm codegen`, lims_shared.dart exports, pnpm-workspace `- contracts`; dart analyze not run.

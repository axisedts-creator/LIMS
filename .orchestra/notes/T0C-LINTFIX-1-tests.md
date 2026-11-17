# T0C-LINTFIX-1 tests (LD-332; lint debt on main: Readiness.missing_env bounds, role pack examples)
- `tools/codegen/__tests__/lintfix1-openapi.test.ts` (Vitest, new): missing_env maxItems/items.maxLength cover the real REQUIRED_ENV (count, longest, parsed from health.ts + storage/env.ts) and are <= 256; role pack examples (listRolePacks 200, applyRolePack request + 200) exist and validate against their own schema (ajv), synthetic; pins that nothing else changed (Readiness/ops required lists, codes, idempotency); `lintRepo(root)` empty; lint rule texts untouched; `staleFiles` empty.
- Existing, must stay green: `tools/codegen/__tests__/lint-openapi.test.ts` (line 477 lintRepo, red now), `services/api/src/core/__tests__/health-env.test.ts`, identity `__tests__/role-packs/*` and `handlers-cover-contract.test.ts`.
- Run: `.orchestra\notes\T0C-LINTFIX-1-verify.cmd` (codegen vitest, then api vitest via pnpm --dir services/api).
- Red now for the right reasons: 6 of 12 new tests (maxItems/maxLength missing, no examples, lintRepo returns the 5 violations).
- Implementer: no example keys under schemas (lint forbids `example` there); put `examples`/`example` on the media type. Regenerated types likely unchanged (TS has no bounds); staleFiles must stay empty.
- NOT tested: wire behaviour of the handlers (unchanged by design), cloud/deploy.

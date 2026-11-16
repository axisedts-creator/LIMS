CHANGES

Reviewed `git diff f202f401d..HEAD` (plus the earlier health.ts/bootstrap/main/test hunks via `main...HEAD`). Ran: `pnpm --dir services/api exec vitest run src/__tests__/env-doc.test.ts src/core/__tests__/health-env.test.ts src/core/__tests__/health.test.ts` -> 3 files, 34/34 pass; `pnpm --dir tools/codegen run codegen:check` -> passes. core.yaml hunk matches LD-288 exactly (one optional property, array of strings, pattern `^LIMS_[A-Z0-9_]*[A-Z0-9]$`, not required, names-only description); nothing else in contracts/. Clean checkout section matches LD-284 (names/commands only). No values/secrets; render.yaml untouched. Regenerated packages/* drift (identity role-packs, quality, operations, msw, routes) is pure codegen output of already-merged contracts, allowed by the LD-288 regenerate sentence and noted in impl notes — OK.

1. services/api/src/core/health.ts:50 — `missing_env` is sent whenever names are unset, including when the status is `down` (503). Brief EXPOSURE NOTE and LD-288 mitigation: "list names only, only when the status is degraded". Fix: `...(missing.length && status === 'degraded' ? { missing_env: missing } : {})`.
2. services/api/src/core/__tests__/health-env.test.ts:99-102 (and header comment line 8 "missing_env still sent") — the test pins the wrong behaviour. Fix: expect `{ status: 'down', checks: { db: 'down', ratelimit: 'ok' } }` with no `missing_env` key on the 503, and change line 8 to "(503, missing_env not sent)".

Not verified: full api suite, lint, typecheck; live readiness on a real deployment.

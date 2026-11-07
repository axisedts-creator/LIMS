APPROVE

Round 8: prior item 1 (CR-C0-0C-004 TRD drift guard) verified fixed at tools/codegen/__tests__/c4-openapi.test.ts:254-256 (CR004 map, billing-only); drift guard passes.

Checks run 2026-11-07: `npx tsx tools/codegen/codegen.ts --check` exit 0, then regenerate + `--check` again exit 0 and `git status` clean (outputs committed, double-run deterministic). `npx vitest run` in tools/codegen: 22 failures, all pre-existing E1/E2 idempotency-justification and "repo spec lint is green" cases in c4/c5/catalog/identity/lint-openapi tests (CR-C0-0C-002 lint conflicts, other tasks), none caused by this diff.

Other checks OK: names verbatim, LD-01/LD-03/AUTO CR-004 applied, no secrets/PHI (synthetic data only), no RLS/SQL in diff, owned paths only.

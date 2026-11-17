Title: CR-C1-NEPAL-001: give `.claude/**` an owner in tools/lint/ownership.yaml
From chunk: C1            To owner: C0-0A
Type: shared-lib
Blocking? no (the kit works; the CI `paths` gate would reject a PR touching `.claude/` until this lands)
Problem: the Nepal migration agent kit lives in `.claude/agents/nepal-migration.md`, `.claude/agents/nepal-coder.md`, `.claude/nepal/guard.sh`, `.claude/nepal/LAUNCH.md`. `tools/lint/check-paths.ts` reports "no single owner" for `.claude/**` (verified: `node tools/lint/check-paths.ts --branch c01/nepal-cutover ...` exits 1). ownership.yaml has no catch-all by design.
Proposed change (exact): add to tools/lint/ownership.yaml
  - pattern: ".claude/**"
    owner: C0-0A
and regenerate .github/CODEOWNERS with `--codeowners-out`.
Backward compatible? yes
Tenant/security impact: none (no RLS, no PHI, no public surface). The agent files only describe how to run agents.
IRD/regulatory impact: none
Alternatives considered: keep the kit outside the repo (rejected: the cloud session must read it from the checkout).
Tests that will prove it: tools/lint/tests/check-paths.test.mjs case for `.claude/agents/x.md` owned by C0-0A.

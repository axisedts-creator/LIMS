APPROVE

Reviewer T0B-DEPFIX-1 (diff b8674372..HEAD), 2026-11-17.

Checked and ran:
- verify.cmd part 1: services/api storage __tests__ + bff-key.test.ts 137/137 pass (15 s run).
- tests/monorepo/T0B-DEPFIX-1.audit.test.mjs 8/8 pass.
- Lockfile diff by hand: only vitest 3.2.4->3.2.6 and its @vitest/* 3.2.x chain, lodash 4.17.21 removed (4.18.1 already locked) and the override line. No auth / session / crypto package moved (done_when 4, 5).
- done_when (1): credential-scan.ts catches PEM, JWT, 40+ hex, mixed base64, service-role/storage-key assigned a literal; ignores env NAMES; both directions tested, plus a real-source scan that asserts core/health.ts is included.
- done_when (2): cause named (cold import inside the 15 s test timer, 6.6 s measured), fixed by a beforeAll warm-up; per-test timeouts unchanged. The vite transform cache survives vi.resetModules, so the warm-up does help.
- done_when (3)/(6): patch/minor fixed, both majors (faker, tinypool) not bumped, CR has exact option and risk; PRODUCTION-BAR row updated (1 high, 2 critical, partly met).
- No PHI, no secrets (test key material built at run time), no names invented, no src change.

Non-blocking notes for the lead (not defects of this diff):
1. docs/ops/PRODUCTION-BAR.md:27 and the impl note point at `.orchestra/cr/T0B-DEPFIX-1.md`; orchestra renamed it to `T0B-DEPFIX-1.nonblocking.md` (aa209dcee). Update the link when the CR is resolved or registered.
2. pnpm-workspace.yaml (C0-0A) is outside the brief's file list; needed because pnpm 12 ignores the package.json "pnpm" field (writer flagged [CONV]). Lead to confirm.
3. contracts/__tests__/ports.test.ts fails now (19 here, writer saw 5): text compare of port files against IC §4 blocks, not version related; outside services/api src/core so not in done_when (7). Pre-existing, needs its own task.
4. Parallel-load proof of the bff-key fix was not run by anyone.

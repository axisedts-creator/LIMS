# T0B-DEPFIX-1 tests (tester)
- NEW services/api/src/core/storage/__tests__/credential-scan.ts (scanner: PEM, hex/base64/JWT literals, service-role assignment; ignores NAMES) + credential-scan.test.ts (both directions + real core/worker sources). adapter.test.ts now uses it. PASS now: health.ts already imports STORAGE_KEY_ENV, so the red test was already green on this branch.
- EDIT services/api/src/core/pipeline/__tests__/bff-key.test.ts: beforeAll warm-up of the cold imports (6.6 s first test alone, 0.3-1.2 s later; cause = cold import inside a 15 s test timer). PASS; parallel-load proof NOT run.
- NEW tests/monorepo/T0B-DEPFIX-1.audit.test.mjs: lockfile vitest >=3.2.6, lodash >=4.18.1 (FAIL now); faker 5.5.3 / tinypool 1.1.1 = gone or CR .orchestra/cr/T0B-DEPFIX-1*.md with GHSA, "option", "risk" (FAIL now); lockfile diff vs main limited to vitest chain/lodash/tinypool/faker, no auth/crypto pkg (vacuous now); PRODUCTION-BAR row counts < 5 and status consistent (FAIL now).
- Run: .orchestra\notes\T0B-DEPFIX-1-verify.cmd
- Not covered: pnpm audit itself (needs network); the ALLOWED set for vitest transitive packages is a guess, writer may extend it with a stated reason.

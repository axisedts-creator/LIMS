Title: CR-C0-DEPFIX-1: two dependency advisories need a MAJOR bump (not done under LD-312)
From chunk: C0-0B            To owner: C0-0A (root package.json, pnpm-workspace.yaml, pnpm-lock.yaml) / lead
Type: bug
Blocking? no (dev/test tooling only; PRODUCTION-BAR "Dependency audit" stays partly met)
Problem: `pnpm audit` 2026-11-17 after T0B-DEPFIX-1 still reports 1 high + 2 critical. LD-312 allows only patch or minor bumps inside the current major; both remaining fixes are majors.

1. @faker-js/faker 5.5.3 — GHSA-qxc2-j82w-r537 (high), fixed >=10.5.0.
   Path: lims (root dev) > @stoplight/prism-cli 5.16.0 > @stoplight/prism-http 5.16.0 > @stoplight/http-spec 7.1.0 > postman-collection 4.5.0 > @faker-js/faker 5.5.3 (exact pin).
   prism-cli 5.16.0 is the latest release and postman-collection 5.3.1 (latest) still pins faker 5.5.3, so no upstream upgrade fixes it.
   Option A (exact): add to pnpm-workspace.yaml overrides `'postman-collection>@faker-js/faker': 10.6.0` (10.6.0 is already in the lockfile).
   Risk A: faker 6+ removed/renamed APIs used by postman-collection (e.g. `faker.random.*`, `faker.name.*`); prism mock example generation for Postman collections may throw at run time. We only feed prism OpenAPI, not Postman collections, but this is not verified by a test.
   Option B: accept the risk (prism is a local dev mock server, never shipped, never sees PHI) and list it in the CI triage file.
2. tinypool 1.1.1 — GHSA-5gmw-xhrv-c9v3 (critical, fixed >=2.1.1) and GHSA-85c8-ppgw-ccpr (critical, fixed >=2.1.2).
   Path: contracts / packages/fakes / tools/codegen > vitest 3.2.6 > tinypool 1.1.1. vitest 3.2.x (incl. 3.2.7 latest 3.x) depends on tinypool ^1.1.1, so no 3.x release fixes it.
   Option A (exact): bump `vitest` 3.2.6 -> 5.1.0 in contracts/package.json, packages/fakes/package.json, tools/codegen/package.json (5.1.0 is already used by services/*, apps/web, packages/ui, root), which brings tinypool >=2.1.2.
   Risk A: vitest 3 -> 5 is two majors: config keys, `vi` mock semantics, pool defaults and reporters changed; those three packages' test suites must be re-run and possibly adjusted.
   Option B: override tinypool to 2.x under vitest 3 — NOT recommended: vitest 3 is not built against tinypool 2 (worker API change), test runs may break.
Proposed change: Option 1B (triage) and Option 2A (vitest 5 in the three packages) as one follow-up task.
Backward compatible? yes for product code (dev dependencies only).
Tenant/security impact: none at run time; dev/test tooling only, no PHI, no public surface.
Alternatives considered: as listed per advisory.
Tests that will prove it: tests/monorepo/T0B-DEPFIX-1.audit.test.mjs (no faker <10.5.0 / tinypool <2.1.2 in lockfile) and `pnpm audit --audit-level high` = 0.

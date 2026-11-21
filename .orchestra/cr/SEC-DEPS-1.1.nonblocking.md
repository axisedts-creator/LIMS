# SEC-DEPS-1.1 (non-blocking): prism-cli dev chain
Title: CR-C1-SEC-DEPS-1.1: prism-cli dev chain keeps @faker-js/faker 5.5.3 and uuid 8.3.2 (not reverted, not removable under SEC-DEPS-1)
From chunk: C1            To owner: C0-0A (root package.json, pnpm-lock.yaml) / lead
Type: bug
Blocking? no (dev tooling only: local mock servers, never shipped, no PHI, not in the production tree)
Problem: after SEC-DEPS-1 (LD-239) `pnpm audit` reports 2 dev-only advisories, both through root devDependency @stoplight/prism-cli 5.16.0 > @stoplight/prism-http > @stoplight/http-spec > postman-collection 4.5.0:
1. @faker-js/faker 5.5.3 — GHSA-qxc2-j82w-r537 (high, fixed >=10.5.0). postman-collection pins faker 5.5.3 exactly; prism-cli 5.16.0 is the latest release.
2. uuid 8.3.2 — GHSA-w5hq-g745-h8pq (moderate, fixed >=11.1.1; only v3/v5/v6 with a caller-supplied buf; postman-collection uses v4 without buf).
Cleared by SEC-DEPS-1: ajv 8.20.0, yaml 2.9.1 (+ yaml 1.10.3 under prism), vitest 5.1.0 everywhere (3.2.x gone, so tinypool 1.1.1 is gone), lodash 4.18.1 (override kept, GHSA-r5fr-rjxr-66jc).
Why prism-cli is kept: it is not a convenience only. Root scripts mock:core ... mock:homecollection and mock:list run it, and tools/codegen/__tests__/c10..c17-openapi.test.ts (tester-owned) assert those scripts exist. Removing it needs those tests changed first, outside the SEC-DEPS-1 file list.
Proposed change (exact), as a follow-up task: either (A) replace the mock servers with a maintained OpenAPI mock and change the c10..c17 tests, then drop @stoplight/prism-cli; or (B) add overrides 'postman-collection>@faker-js/faker': 10.6.0 and 'postman-collection>uuid': 11.1.1 with GHSA comments, after proving prism mock still serves examples (faker 6+ renamed APIs; postman-collection may throw only on Postman collections, which we never feed it).
Backward compatible? yes (dev dependencies only).
Tenant/security impact: none at run time; prism binds 127.0.0.1 and serves synthetic examples only. The CI full-tree audit step is non-blocking for this reason; the blocking step audits --prod.
Alternatives considered: pnpm audit fix (banned by LD-239); leaving the advisories unrecorded (rejected).
Tests that will prove it: tests/security/sec-deps1.test.mjs (this CR names the packages and versions); for A or B, `pnpm audit --audit-level=high` = 0 and the c10..c17 tests green.

Title: CR-C4-FD-T03: add devDependency "pg": "8.23.1" to services/api for repository integration tests
From chunk: C4            To owner: C0-0D (lockfile: C0-0A)
Type: shared-lib
Blocking? yes — C4 FD-T03 done_when "Queries pass on migrated PG17 with tenant_a/b seeds" (integration tests in tests/frontdesk need a PG client resolvable from services/api)
Problem: FD-T03 repo integration + cross-tenant SELECT/INSERT probes (07-SECURITY §6) connect to a real PG17 via `pg`.
`pg` 8.23.1 is already resolved in pnpm-lock.yaml (transitively via graphile-worker) but is not declared in
services/api/package.json, so it is not importable from services/api. package.json is C0-0D-owned and pnpm-lock.yaml
is C0-0A-owned (01-CHUNK-MAP §3); C4 reverted its own edit to both.
Proposed change (exact): services/api/package.json devDependencies += `"pg": "8.23.1"`; pnpm-lock.yaml importers
services/api devDependencies += `pg: { specifier: 8.23.1, version: 8.23.1 }` (no new package download; version already locked).
Backward compatible? yes (additive devDependency, test-only).
Tenant/security impact: none; no runtime dependency, no RLS change, no PHI field, no public surface.
Alternatives considered: C4 edits package.json/lockfile itself — rejected (not owned); use another client — rejected (pg already in tree).
Tests that will prove it: `tests/frontdesk/FD-T03.pg.sh` (docker PG17, migrations + tenant_a/b seeds) = 83/83 pass (measured with the dependency present).

Title: CR-C7-API-T14: JobContext needs `ports` (IdentityPort, CatalogPort) and `metrics` for module worker tasks
From chunk: C7            To owner: C0-0D (services/worker/src/core: manifest.ts JobContext, consumer.ts jobContext())
Type: shared-lib
Blocking? no for API-T14 tests (they hand-build ctx); yes for running the instruments tasks in the real worker (evaluate_agent_health, export_agent_state_metrics, refresh_observed_code_mapping, purge_archive would throw on ctx.ports / ctx.metrics = undefined).
Problem: 02-TRD §10 requires `IdentityPort.getTenantSettings` (purge step 1, tenant timezone for AC-13.4), `CatalogPort.mapInstrumentCode` (AC-17.3) and Prometheus gauges/counters set from worker tasks (AC-13.6, lims_instruments_archive_purged_rows_total). JobContext (manifest.ts) has no `ports` or `metrics`; WorkerDeps has `metrics` but jobContext() does not pass it on.
Proposed change (exact): manifest.ts `JobContext` += `readonly metrics: WorkerDeps['metrics']; readonly ports: Readonly<Record<string, unknown>>` (or typed `{ IdentityPort: IdentityPortV1; CatalogPort: CatalogPortV1; ... }`); WorkerDeps += `readonly ports`; consumer.ts jobContext() copies `metrics: deps.metrics, ports: deps.ports`.
Backward compatible? yes (additive).
Tenant/security impact: none new; ports are called with the job's system ctx (tenant claims already set by the wrapper).
Alternatives considered: instruments importing the identity/catalog services directly (rejected: cross-module import, 02-CV module boundaries).
Tests that will prove it: worker core test that a module task sees ctx.metrics === deps.metrics and ctx.ports === deps.ports; instruments tests already use that shape (services/worker/src/jobs/instruments/__tests__/helpers.ts header).

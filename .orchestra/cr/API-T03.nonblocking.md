Title: CR-C7-API-T03: add lims_instruments_device_auth_failures_total to core metric table
From chunk: C7            To owner: C0-0A (core services/api/src/core/observability/metrics.ts)
Type: shared-lib
Blocking? no (resolver ships with a no-op sink in instruments/index.ts; metric + alert InstrumentsDeviceAuthFailureSpike are dark until merged)
Problem: 02-TRD §7.1 / metrics table requires counter `lims_instruments_device_auth_failures_total{reason}` (reason: format|unknown). Core `metrics.ts` DEFS lacks it, so createMetrics/inc would throw; modules cannot register metrics.
Proposed change (exact): DEFS += `lims_instruments_device_auth_failures_total: ['counter', ['reason'], 'Failed device credential resolutions']`, and expose a `{ inc(name, labels) }` sink to module manifests (or let core pass its metrics into the instruments manifest) so `createDeviceTokenResolver({ metrics })` gets the real registry.
Backward compatible? yes
Tenant/security impact: none; label carries only `reason`, never credential material (tested).
Alternatives considered: module-local prom-client registry (splits /metrics, rejected).
Tests that will prove it: core metrics test lists the name; instruments device-credentials.test.ts already asserts inc(name,{reason}).

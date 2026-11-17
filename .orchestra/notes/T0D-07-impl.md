# T0D-07 impl (writer)
- Files: `services/api/src/core/ports/{registry,phase-stubs,authz-guard}.ts`. Ports suite 135/135; `tsc --noEmit` clean. Review fix: authz metric now carries `{operation_id}` label (02-TRD:1038).
- [CONV] `resolvePorts` collects every boot error (unknown/foreign/duplicate export, bad or non-dev/ci `LIMS_CORE_FAKE_PORTS`, unresolvable port) and throws once, listing all.
- [CONV] Order: dev/ci = forced fake > real > fake; staging/production = real > listed phase stub (needs both list entry and stub impl) > fail. Fakes never in staging/prod.
- [CONV] `portsFor(module)` = frozen object of lazy getters; unlisted read logs `port_consumer_not_listed{module,port}` (error), then throws `LimsError('common.internal')` without detail, or in production returns impl + `lims_core_port_consumer_not_listed_total`.
- [CONV] `consumers` is required (no default) until T0C-05 emits `contracts/ports/generated/port-consumers.ts`; owners/phaseStubs default to `PORT_OWNERS`/`PHASE_STUBS`.
- [CONV] Authz guard state is kept in a WeakMap keyed by the frozen request object, so handlers cannot set `asserted`; only `public` exempts (identity_auth ops carry x-public, D-212).
- Open: wire `resolvePorts` into API/worker boot and `check` into pipeline stage 9 (T0D-01 follow-up). Full api suite has 1–5 timeouts in Fastify tests (boot/errors/health/openapi/http) under load; these tests don't import ports code.

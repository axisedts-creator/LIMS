Title: CR-C16-nnn: core never runs authResolvers, so every patientPreAuth operation answers 401
From chunk: C16            To owner: C0-0D (core auth / pipeline)
Type: shared-lib (core)
Blocking? yes — patient app sign-in (E1 getPatientAppConfig, E2 requestPatientOtp, E3 verifyPatientOtp) cannot work on any deployed API.

Problem (what you cannot do today):
  `GET /v1/engagement/app/config` with a valid `X-Lims-Patient-PreAuth: t.<tenant_code>` for a seeded, active tenant answers
  401 auth.unauthenticated in ~1 ms (no DB round trip). Observed on the staging API at deploy commit 5bcc98a (and main).
  Cause: services/api/src/core/openapi.ts `securityHandlers()` registers only `bearerJwt` and `bffSession`; its own comment says
  schemes without a handler fail closed. `createAuthResolverRegistry` (core/auth/resolvers.ts) is exported but never called outside
  tests, so `modules/engagement/auth/preauth.resolver.ts` (patientPreAuth) and the other resolver schemes (portalSession,
  queueDisplayToken, deviceToken ...) are never invoked. The DB side was verified separately: tenant_a is active and
  app.core_resolve_tenant_code is executable by lims_api.

Proposed change (exact, for C0-0D to design):
  1. bootstrap.ts: build `createAuthResolverRegistry(modules.map(m => m.manifest))` and pass it in CoreAuth.
  2. openapi.ts securityHandlers: for each apiKey scheme that has a registered resolver, read its header (spec `securitySchemes.<name>.name`),
     run `registry.authenticate(scheme, credential, tx)` inside a short pre-claims DB transaction (resolver contract: "the only SQL is a
     SELECT of a DEFINER function"), and set `requestAuth.claims` to the returned DbClaims, so pipeline.run continues with claims.
  3. Decide how that pre-claims transaction is opened (the pipeline today only has the identity-actor path, LD-204).
Backward compatible? yes — schemes without a registered resolver keep failing closed.
Tenant/security impact: authentication surface of every non-bearer scheme; fail-closed on any resolver error; uniform
  auth.unauthenticated for unknown/suspended/expired credentials (REQ-SEC-017). Needs security review.
Alternatives considered: patching handlers inside modules/engagement (not possible: auth runs before the handler); a fixed bypass
  (rejected, security).
Tests that will prove it: core/openapi test — patientPreAuth `t.<code>` for an active tenant reaches the handler with claims
  {tenant_id, actor patient, patient_stage pre_auth}; unknown tenant, malformed credential, missing header -> 401; resolver throws -> 401/500
  fail closed; same checks for portalSession.

Related local, uncommitted change by C16 (inside its own paths): LIMS_ENGAGEMENT_OTP_TEST_CODE (services/api/src/modules/engagement/config.ts,
service/auth.service.ts, tests, .env.example): opt-in fixed login OTP for staging tests, refused when LIMS_CORE_ENV=production.

DRAFT IMPLEMENTATION (local, uncommitted, for C0-0D review; not pushed, not deployed):
  - core/db/allowlists.ts: PRE_AUTH_SCHEMES = ['patientPreAuth'] (frozen; portalSession/deviceToken/... stay fail-closed until reviewed).
  - core/db/tx.ts: db.preAuthTx({ ...TxInput, scheme }, fn): claims fixed to {}, refused (common.internal, before any SQL) unless scheme is allowlisted; kind 'pre_auth' cannot use withTenantScope.
  - core/pipeline/boot.ts: PipelineBoot exposes `db`.
  - core/openapi.ts: CoreAuth.preAuth; securityHandlers(auth, spec) registers a handler per allowlisted apiKey-in-header scheme: reads ONLY that header,
    requires the operation's module to own the scheme (AUTH_RESOLVER_OWNERS), then authenticate() -> request claims. Any failure -> 401.
  - core/bootstrap.ts: builds createAuthResolverRegistry(modules) and binds the Db after bootPipeline (no DB => fail closed).
  - Tests: core/db/__tests__/pre-auth.test.ts (13), core/__tests__/preauth-handler.test.ts (9). typecheck clean.
  - Known pre-existing failures, unrelated: engagement boot.test.ts (PHASE_STUBS), core/storage adapter.test.ts (health.ts mentions a storage key name).
  - Not verified: against a real database / the staging API. Open question for review: the resolver's SELECT runs as lims_api with claims '{}'.

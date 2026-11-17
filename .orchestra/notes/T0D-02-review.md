APPROVE

# T0D-02 review (reviewer) — diff bae9e79..bcf34bd

Checked against C0 01-PRD AC-0D-2.1/2.2/2.2a/2.5, 02-TRD §6.3/§6.4/§6.5 + config rows (945, 959), 07-SECURITY REQ-SEC-013/066/067/128 + AB-26, C2 02-TRD §6.1 (VerifiedJwt / ResolvedClaims / ClaimsResolver), 02-CV P-61, 08 A19 P-45.

- Names verbatim: `LIMS_CORE_JWT_{ALG,ISSUER,AUDIENCE,KEY_FILE}`, `LIMS_{WEB,PARTNER,PORTAL}_BFF_KEY_FILE` (the names `LIMS_CORE_BFF_KEY_FILES` lists), `LIMS_CORE_TRUSTED_PROXY_CIDRS`, BFF kinds, endpoint families, ResolvedClaims kinds, DbClaims fields, extraClaims allowlist, AUTH_RESOLVER_OWNERS, error codes (all present in contracts/errors.yaml with the right http).
- JWT: exact pinned alg, local key file only (no jku/jwk/x5u/kid), ES256 curve + RSA key type checked, 0 s exp leeway, 60 s nbf/iat skew, iss/aud, session_id required, other claims dropped. Fails boot on missing/garbage key.
- Tenant: claims only from claimsResolver / AuthResolver output; resolver missing -> 500 fail closed; reserved claims cannot be injected via extraClaims.
- clientIp: XFF only with verified BFF key or trusted CIDR peer, bare IP literal only; Fastify trustProxy off.
- Glue: schemes without a handler throw a string -> unwrapped to 401 `auth.unauthenticated` (verified in fastify-openapi-glue 4.12.0 lib/securityHandlers.js). `security: []` gets no preHandler.
- No secrets / PHI logged (AuthError message = code only; key-file errors give path only). Paths: all under services/api/src/core (C0-0D, chunk map §3) + own notes.
- RLS/idempotency/rate tier: not in scope of this task (T0D-03/04/05+).

Ran: `pnpm --dir services/api exec vitest run` -> 9 files, 457/457 passed. `tsc --noEmit` -> clean.

Non-blocking notes (no change needed now):
- `BffKeyVerifier.reload()` has no trigger (no SIGHUP/watch); rotation therefore = put old+new lines in the file and restart. Fine for the C1 runbook; add a trigger if C1 wants hot rotation.
- AC-0D-2.2 DB half (`app.current_tenant_id() = A`) needs T0D-03 (set_config); tests here stop at the resolver boundary.

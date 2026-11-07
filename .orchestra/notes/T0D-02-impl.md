# T0D-02 impl (writer)
- New `core/auth/`: jwt.ts (node:crypto, pinned alg, local key file), bff-key.ts (sha256+timingSafeEqual, reload), client-ip.ts (net.BlockList, ::ffff unmap), claims.ts, claims-resolver.ts (authenticateBearer, endpointFamilyOf), resolvers.ts, errors.ts (AuthError; status from contracts/errors.yaml).
- Touched core: config.ts (LIMS_CORE_JWT_*, LIMS_{WEB,PARTNER,PORTAL}_BFF_KEY_FILE, LIMS_CORE_TRUSTED_PROXY_CIDRS), openapi.ts (onRequest clientIp/bffKind, glue securityHandlers.bearerJwt, SecurityError unwrapped to the auth error, `claimsOf(req)` for T0D-03), bootstrap.ts (builds verifiers at boot), module.ts (HandlerContext.clientIp, AUTH_RESOLVER_OWNERS exported).
- [CONV] JWT config all-four-or-none; with none, mounting any bearerJwt op fails boot (existing T0D-01 production config tests stay valid). Token cap 16 kB; BFF key / AuthResolver credential cap 4096.
- [CONV] XFF must be one bare IP literal (no list, no zone id) else peer. HS256 key file: one trailing newline stripped. Unknown registry code on auth path -> 401. Malformed resolver output -> 500 common.internal.
- [CONV] endpointFamily: /v1/identity/auth/patient/* patient, /v1/identity/mobile/* mobile, other /v1/identity/auth/* partner|staff by BFF key, else api.
- Checks: auth suite 416/416, full api suite 457/457, `tsc --noEmit` clean. No lint script in services/api.
- Open: AuthError -> LimsError + problem+json body (T0D-04); claims into set_config (T0D-03); bffSession/deviceToken etc. security handlers not wired (glue fails them closed, 401); requestId is Fastify's req.id until T0D-10.

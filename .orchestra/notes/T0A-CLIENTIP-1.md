# T0A-CLIENTIP-1 — what a verified BFF kind changes for a bearer request (read before sending the key from serverFetch)
- openapi.ts onRequest: bffKind gates X-Forwarded-For trust (client-ip.ts). bearerJwt: endpointFamilyOf(route, bffKind) only differs for /v1/identity/auth/* ('partner' key -> partner family); module routes are 'api' regardless.
- claims-resolver.ts forwards bffKey to the identity resolver: 'portal' key rejected on non-'api' families; the byKey kind check runs only when endpointFamily !== 'api'. staff_web key on 'api' routes: no change.
- ctx.bffKey reaches handlers (pipeline LD-206); only identity /v1/identity/auth/* handlers read it (login, confirmEmailToken, setPasswordFromSetup, session.service). serverFetch never calls /v1/identity/auth/* (all its paths are module routes incl. /v1/identity/me|centres|branches = 'api').
- Rate limit: 'general' tier keys on actor + tenant, not on the BFF key. Authz: unaffected.
- Verdict: for serverFetch's callers the key changes only the client address -> key IS sent (readBffKey, cached; a failed read sends no key and is retried next call).
- Open point: c2Resolver also runs from middleware; if next/headers is unavailable there the resolveSession call sends no address/user agent (fail-soft {}). Post-deploy auth_events check will show it.

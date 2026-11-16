APPROVE
# T0A-CLIENTIP-1 review (diff e6e643152..HEAD)
- API client-ip.ts: leftmost entry only when bffKind is set; the no-key path and the trusted-CIDR-without-key path keep the single literal rule; junk/port/zone/CIDR leftmost entries fall back to the peer. Matches LD-296 and done_when (3).
- Web client-context.ts: first XFF entry else x-real-ip, bare literal only (isIP, no %zone); user agent trimmed, then capped at 512; returns {} outside a request scope; nothing logged; copies nothing else. Used by login `call`, c2Resolver and serverFetch (done_when 1).
- serverFetch key on reads: the notes analysis (openapi.ts / claims-resolver.ts) shows a staff_web key on 'api' family routes changes only the client address. A readBffKey throw is not cached and sends no key (done_when 2).
- Middleware runtime is 'nodejs' (src/middleware.ts:14), so the node:net import in c2.ts is safe there.
- Names are verbatim (X-Lims-Bff-Key, LIMS_CORE_TRUSTED_PROXY_CIDRS, LD-296). No migration, RLS, authz, throttling, contract or secret changes. No PHI or secrets in logs. The CR is nonblocking and covers 02-TRD §6.4 / 08 A25 P-61.
- Ran: client-ip.test.ts 83/83 passed; vitest.clientip1 config (4 web files) 82/82 passed. env-doc.test fails only on LIMS_CORE_AUTHZ_MODE. The name is missing from the doc at base e6e643152 and this diff adds no code that reads it, so the failure predates this task.
- Non-defect notes: there are 12 non-.orchestra files against a soft limit of 10, but the extras are tests that done_when (4) requires. Whether headers() returns values inside Node middleware is still open; the writer flagged it as fail-soft, and the post-deploy auth_events check decides it.

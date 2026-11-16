# T0A-CLIENTIP-1 impl (writer)
- New apps/web/src/core/api/client-context.ts: readClientContext() + clientContextHeaders(); used by c2.ts, server-fetch.ts, admin/auth/actions.ts (old clientIp() removed).
- serverFetch sends X-Lims-Bff-Key via readBffKey (cached; throw -> no key, not cached). Analysis in notes/T0A-CLIENTIP-1.md: key changes nothing beyond the address on serverFetch routes.
- services/api client-ip.ts: with bffKind, leftmost XFF entry (bare literal) else peer; trusted-CIDR path unchanged.
- [CONV] client-context.ts has no 'server-only' import: c2.ts is imported by middleware and c2.permissions.test does not mock it; next/headers + node:net keep it server-side.
- docs/runbooks/environment.md one note; CR .orchestra/cr/T0A-CLIENTIP-1.nonblocking.md (02-TRD §6.4, 08 A25 P-61 text).
- Tests: client-ip 83/83, clientip1 web 82/82, t12 154/154, actor2 27/27, dep02 24/24, auth-redirect 80+90, API core 738/738. Pre-existing fail: env-doc.test (LIMS_CORE_AUTHZ_MODE undocumented, not this task).
- Open: c2Resolver via middleware may get {} if next/headers unavailable there; live check after redeploy decides.

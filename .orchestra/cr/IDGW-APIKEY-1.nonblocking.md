Title: CR-C1-IDGW-APIKEY-1: record the `apikey` header and the optional LIMS_IDENTITY_GOTRUE_PUBLISHABLE_KEY in the C2 TRD and env table
From chunk: C1            To owner: C2 (spec owner of 02-TRD identity gateway and the env table) via lead
Type: port
Blocking? no (non-blocking CR; LD-199 already authorises the code change; this CR only keeps the spec in step).
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
Hosted Supabase Auth rejects gateway calls with no `apikey` header (401 `No API key found in request`), so staging sign-in and the platform-admin bootstrap fail. The C2 TRD and env table do not mention `apikey` or a publishable key (REQ-SEC-029/030, CR-C2-014).
Proposed change (exact): in the C2 TRD gateway section add: "Admin calls (`/admin/*`, `/invite`) send `apikey` and `Authorization: Bearer` both equal to LIMS_IDENTITY_GOTRUE_SERVICE_KEY. Every other call sends `apikey` equal to LIMS_IDENTITY_GOTRUE_PUBLISHABLE_KEY only when set and non-empty, never the service key; unset = no apikey header (self-hosted GoTrue)." In the env table add LIMS_IDENTITY_GOTRUE_PUBLISHABLE_KEY: optional, not a secret but never logged, read only inside gotrueGatewayFromEnv, empty by default.
Backward compatible? yes — with the variable unset, request headers are unchanged on non-admin calls; admin calls gain an apikey header that GoTrue ignores.
Tenant/security impact: no RLS change, no PHI, no new surface. The service key still goes only on admin calls (REQ-SEC-029/030 unchanged); the CI job identity-service-key-grep stays green.
IRD/regulatory impact: none.
Alternatives considered: send the service key as apikey on every call (rejected: breaks REQ-SEC-030); add a gateway proxy that injects apikey (rejected: extra hop for a header).
Tests that will prove it: services/api/src/modules/identity/gotrue/__tests__/apikey.unit.test.ts.

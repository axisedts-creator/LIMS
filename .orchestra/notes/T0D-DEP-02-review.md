APPROVE

T0D-DEP-02 review (diff 0e199710..62f59645)
- bff-key.ts matches LD-174 order exactly: file wins (same 'is empty' / 'is not set' messages); env fallback only for LIMS_CORE_ENV in {dev, ci, staging} (exact Set match, case-sensitive); empty/whitespace env value throws 'LIMS_WEB_BFF_KEY is empty'; everything else fails closed with 'LIMS_WEB_BFF_KEY_FILE is not set'. NODE_ENV not read. No key value in messages, no logging, no NEXT_PUBLIC_ name.
- c2.ts keeps cachedKey and calls readBffKey; actions.ts changes only the bffKey block and its node:fs import. Importers chain (c2 via store.ts/provider.ts, actions.ts has 'server-only') has no 'use client' file.
- Only owned/listed paths touched (plus tester's test-only vitest config and notes); services/api, apps/portal, apps/partner untouched. No secrets (synthetic test keys only).
- Tests cover every done_when case, including the static single-reader scan. The t12 admin-auth tests are unchanged.
- Ran: DEP-02 config 24/24 pass; vitest.t12.config.ts 120/120 pass (3 files).
- Not applicable: RLS, permissions, idempotency, rate tier, error codes (no API/DB surface in this task).

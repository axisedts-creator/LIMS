# SP-4 — Storage/Realtime `request.jwt.claims` cross-tenant probes

- Date run: 2026-11-07 · Plan row: `spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md` SP-4 · 04 D3 · 05-SCHEMA §8 · REQ-SEC-034/035/036 · 08 R10, R12b
- **Outcome: api-proxied.** Storage is reached only through the API/worker with server credentials (`ctx.storage`, 08 R12b / CR-C2-011). No end-user storage policies are created on `storage.objects`; T0B-12 creates the 08 §4.8 buckets private and skips `*_storage__create_policies.sql`.
- Fallback selected: the plan row's second path (api-proxied); storage-policies rejected.

## Decision

| Item | Result |
|---|---|
| Does self-hosted Storage populate `request.jwt.claims` from the bearer JWT (04 D3 mechanism)? | **Yes.** With a token carrying `tenant_id`, the §8 policy admitted the same-tenant read and denied every cross-tenant read and write. |
| Does self-hosted Realtime do the same for private channels? | **Yes.** `realtime.topic()` policy admitted the same-tenant join and rejected foreign-tenant joins (`Unauthorized`). |
| Can an end-user token reach those policies in LIMS? | **No.** 08 R10 picks session-resolved claims: `tenant_id`/`actor_type`/`membership_id` come from the identity claims resolver inside the API, not from the JWT (no GoTrue hook; CR-C0-007 dropped `app.custom_access_token_hook`). The real GoTrue access JWT has no `tenant_id` (SP-1 claim keys, re-checked below), so `app.current_tenant_id()` is NULL under Storage/Realtime and the policy denies even the owning tenant. |
| Why not storage-policies | It would need a second token issuer that puts resolver claims into a Storage-verifiable JWT. 08 R10 has no such issuer, and adding one is a design change, not a C0 call. |

Consequences:

- **T0B-12**: buckets of 08 §4.8 private, no end-user `storage.objects` policies (05-SCHEMA §8 "until SP-4 passes" branch stays in force). REQ-SEC-034 is met by the `ctx.storage` adapter (first path segment = `ctx.tenantId`, module bucket prefix) plus private buckets; tests target the adapter (C0-0D) and "authenticated role reads nothing" on `storage.objects`.
- **C6 / C4**: their TRDs already use the server-side path (C6 02-TRD §CR block "no client-side Storage access in any case"; C4 07-SECURITY streams files through F21a/B29a). No C6 CR needed (CR-C2-011 / R12b already server-side); C4 wording CR: `.orchestra/cr/SP-4.nonblocking.md`.
- **REQ-SEC-035**: `ctx.storage.signedUrl` stays internal; signed URLs never reach a browser or a log (logger denylist `url`). This record contains no signed URL.
- **REQ-SEC-036 / T0B-14**: `realtime.messages` policies stay gated and Flutter-only (04 S5). Realtime enforcement works, but the Flutter apps hold an opaque LIMS session token, not a GoTrue JWT (08 R10, CR-C17-004), and no JWT carries `tenant_id`. T0B-14 does not create Realtime policies; C16/C17 keep polling (C16 02-TRD) until a CR defines a tenant-bearing Realtime token. Phase-3 relevance, so this can lag.

## Probe setup

- Stack: local Supabase CLI 2.105.0 dev stack `LIMS` — `storage-api:v1.89.13`, `realtime:v2.103.2`, `gotrue:v2.197.0`, `postgres:17.11.0.018`, via Kong `http://127.0.0.1:54321`.
- Temporary DB objects (as `supabase_admin`, dropped after): schema `app` with `app.current_claims()` / `app.current_tenant_id()` copied verbatim from `db/migrations/20261105000100_app__create_context_helpers.sql` (`current_setting('request.jwt.claims', true) ->> 'tenant_id'`); bucket `reports` (private); the 05-SCHEMA §8 policy verbatim; a probe-only `realtime.messages` SELECT policy on the topic prefix `tenant:{tenant_id}:`.
- Policy under test (05-SCHEMA §8, first path segment):

```sql
CREATE POLICY reports__select__tenant ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'reports' AND (storage.foldername(name))[1] = ((SELECT app.current_tenant_id()))::text);
-- probe only, dropped afterwards:
CREATE POLICY sp4_probe__realtime_select ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() LIKE 'tenant:' || (SELECT app.current_tenant_id())::text || ':%');
```

- Tenants: tenant A and tenant B = random UUIDs; one synthetic PDF each at `reports/<tenant>/sp4-*.pdf`, uploaded with the service credential (the `ctx.storage` path).
- Tokens: C2's login flow and claims resolver are not built yet. (1) **Resolver-shaped tokens** for tenant A and tenant B: HS256 with the stack JWT secret, claims `iss/aud/role=authenticated/sub/exp/iat` plus `tenant_id`, `actor_type=user`, the claims the resolver puts into `request.jwt.claims` for the API. This is the best case for storage-policies. (2) **Real GoTrue access JWT** (password grant for synthetic user `sp4-<random>@example.test`): the `bearerJwt` credential a client actually holds. (3) A forged token claiming tenant B, signed with a wrong key.
- No tokens, keys or signed URLs were printed or recorded; the probe script printed only status codes, error bodies and claim key names.

## Evidence

Commands (throwaway script outside the repo, Node 25 `fetch`/`WebSocket`):

```sh
supabase status -o json                      # keys read in-process, never printed
docker exec -i supabase_db_LIMS psql -U supabase_admin   # setup SQL above
# Storage API, base http://127.0.0.1:54321/storage/v1, apikey = anon
POST   /object/reports/<A>/sp4-a.pdf, /object/reports/<B>/sp4-b.pdf     (service credential seed)
GET    /object/authenticated/reports/<X>/...   POST /object/list/reports {prefix}
POST   /object/sign/...   GET /object/info/authenticated/...
POST   /object/reports/<B>/sp4-x.pdf   PUT /object/reports/<B>/sp4-b.pdf
DELETE /object/reports {prefixes}      POST /object/move {sourceKey,destinationKey}
POST   /auth/v1/admin/users ; POST /auth/v1/token?grant_type=password    (synthetic user)
# Realtime: ws://127.0.0.1:54321/realtime/v1/websocket?vsn=1.0.0
phx_join topic realtime:tenant:<X>:probe  {config:{private:true}, access_token}
# cleanup: Storage API object + bucket delete, DROP POLICY x2, DROP SCHEMA app CASCADE, delete synthetic user
```

Output (Storage returns HTTP 400 with the inner `statusCode` in the body):

```text
service upload tenant A object                       POST   200 {"Key":"reports/5d84c3b3-…/sp4-a.pdf"}
service upload tenant B object                       POST   200 {"Key":"reports/4c0d2e7b-…/sp4-b.pdf"}
--- resolver-shaped tokens (tenant_id in claims)
same-tenant read (A reads A)                         GET    200 %PDF-1.4 …
cross-tenant read (A reads B)                        GET    400 {"statusCode":"404","error":"not_found","code":"NoSuchKey"}
cross-tenant read (B reads A)                        GET    400 {"statusCode":"404","error":"not_found","code":"NoSuchKey"}
cross-tenant list (A lists B prefix)                 POST   200 []
cross-tenant sign URL (A signs B)                    POST   400 {"statusCode":"404","code":"NoSuchKey"}
cross-tenant info (A head B)                         GET    400 {"statusCode":"404","code":"NoSuchKey"}
cross-tenant write: upload new (A writes B/x)        POST   400 {"statusCode":"403","message":"new row violates row-level security policy"}
cross-tenant write: overwrite (A upserts B)          PUT    400 {"statusCode":"403","message":"new row violates row-level security policy"}
cross-tenant write: delete (A deletes B)             DELETE 200 []        (0 rows deleted; B intact below)
cross-tenant write: move (A moves B to A)            POST   400 {"statusCode":"404","code":"NoSuchKey"}
same-tenant write (A writes A; no INSERT policy)     POST   400 {"statusCode":"403","message":"new row violates row-level security policy"}
forged token claiming tenant B (wrong key)           GET    400 {"statusCode":"403","message":"signature verification failed"}
anon key only reads A                                GET    400 {"statusCode":"404","code":"NoSuchKey"}
service re-read B after attacks                      GET    200 %PDF-1.4 …
db objects in reports: sp4-b.pdf,sp4-a.pdf           (nothing written, moved or deleted by tenant A)
--- real GoTrue access JWT
gotrue token 200 alg ES256 claim_keys aal,amr,app_metadata,aud,email,exp,iat,is_anonymous,iss,phone,role,session_id,sub,user_metadata  tenant_id present: false
GoTrue JWT reads tenant A object                     GET    400 {"statusCode":"404","code":"NoSuchKey"}   (same-tenant denied: no tenant_id)
GoTrue JWT lists tenant A prefix                     POST   200 []
--- Realtime private channel join
same-tenant join (A token, tenant A topic)           phx_reply {"status":"ok"}
cross-tenant join (A token, tenant B topic)          phx_reply {"status":"error","reason":"Unauthorized: You do not have permissions to read from this Channel topic: tenant:4c0d2e7b-…"}
foreign-tenant join (B token, tenant A topic)        phx_reply {"status":"error","reason":"Unauthorized: … topic: tenant:5d84c3b3-…"}
GoTrue JWT join (tenant A topic)                     phx_reply {"status":"error","reason":"Unauthorized: … topic: tenant:5d84c3b3-…"}
cleanup: bucket delete 200; DROP POLICY x2; DROP SCHEMA app CASCADE; synthetic user deleted; storage/realtime policies = 0, buckets = 0
```

Reading: every cross-tenant read and write attempt was denied, by RLS (403 `new row violates row-level security policy`) or by not finding the object (`NoSuchKey`, empty list, 0 rows deleted). Same-tenant read works with resolver-shaped claims and through the server credential. Same-tenant read fails with the token clients actually hold. So under api-proxied the positive path is `ctx.storage` (server credential, 200 above), and end users have no direct Storage access at all.

## Open points

- C4 07-SECURITY REQ-SEC-034 row says "CHECK + storage policy". Under api-proxied there is no storage policy; the guards are the CHECK plus the `ctx.storage` adapter. This is a wording fix for the C4 doc owner, with no behaviour change; filed as `.orchestra/cr/SP-4.nonblocking.md`.
- Probed on the CLI dev stack, not the C1 self-hosted compose stack. Re-run when `infra/compose/supabase/upstream/UPSTREAM.lock` lands, only if a future CR proposes a tenant-bearing token for Storage/Realtime.
- To revisit storage-policies or Realtime policies, raise a CR against 08 R10 for a token issuer that carries `tenant_id` and is verifiable by Storage/Realtime. Today's probe shows the enforcement side would work.

## Provisioning contract (LD-55)

Ruled by the lead on 2026-11-07 (CR-C0-T0B-12-b). Used by `db/provisioning/create-storage-buckets.mjs` (T0B-12, LD-54). The routes come from the storage-api source at tag v1.89.13 (the version this probe ran) and are confirmed live only by the first-deploy smoke test in `db/provisioning/README.md`.

1. Base URL env `LIMS_CORE_STORAGE_URL` [CONV]: internal base URL of the Storage API including its path prefix, for example `http://<internal-host>:<port>/storage/v1`. Internal only (the public edge returns 404 for /storage/v1). No default value and no hard-coded host; if it is unset the script prints one line and exits non-zero.
2. Endpoints relative to that base: `GET /bucket?limit=100&offset=N` (JSON array of objects with id, name, public; page until a page has fewer than 100 items); `POST /bucket` with JSON `{"id":"<name>","name":"<name>","public":false}` (200 on create); `PUT /bucket/{id}` with JSON `{"public":false}` (200 on update).
3. Auth: header `Authorization: Bearer <credential>` and header `apikey: <credential>`. Credential = contents of the file named by `LIMS_CORE_STORAGE_KEY_FILE`, surrounding whitespace trimmed; never printed or logged.
4. Idempotency does not depend on an "already exists" response: list first; POST only absent buckets; PUT `{"public":false}` for a listed bucket whose public flag is true; leave private ones untouched. If a POST returns non-2xx, list again and accept only if the bucket now exists and is private, otherwise exit non-zero. Any non-2xx on a list or a PUT exits non-zero. Output is only bucket names and created/ok/flipped, never a credential, URL or response body. Error body shapes are unspecified and are not relied on.

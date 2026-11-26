Title: CR-TENANT-LOGO-1: each tenant's own logo, set by the platform super admin at provisioning and shown in the staff sidebar
From chunk: founder request (2026-11-26, direct session)            To owner: C2 (identity), C0-0D (staff shell, core allowlist), doc owner (13-M-SERIES s3)
Type: api + ui-kit
Blocking? no. Built ahead of approval on branch `feat/tenant-logo` at the founder's instruction ("Build now + file CR"); nothing is merged or deployed.

Problem (what you cannot do today, with the user story / acceptance criterion it serves):
The founder wants every tenant (lab) to see its own logo in place of the Metro Labs logo, set by the platform super admin while creating the tenant, with strict tenant separation.
1. A platform operator cannot upload a branding image for a tenant: `uploadBrandingAsset` is tenant context only, and the platform settings PATCH refuses asset pointers (tenant.service `PLATFORM_EDITABLE`).
2. Ordinary staff cannot load their lab's logo: `getBrandingAssetContent` and `getSettings` need `identity.settings.manage`.
3. 13-M-SERIES s3 (LD-251) fixes the sidebar logo to Metro Labs for every tenant.

Proposed change (exact):
A. contracts/openapi/identity.yaml, two additive operations (names are NEW, not from the spec; modelled on the existing ones):
   - `POST /v1/identity/platform/tenants/{tenant_id}/branding-assets`, operationId `uploadBrandingAssetAsPlatform`, x-permission `platform.tenant.manage`, x-context `platform`, x-idempotency required, body `BrandingAssetUpload`, 201 `BrandingAsset`. Same error codes and x-upload as `uploadBrandingAsset`, plus 404.
   - `GET /v1/identity/me/tenant-logo/content`, operationId `getOwnTenantLogoContent`, x-permission `identity.self.manage`, x-context `tenant`, no parameters, same response as `getBrandingAssetContent`, 404 when no logo.
B. services/api/src/core/db/allowlists.ts: `uploadBrandingAssetAsPlatform` added to `WITH_TENANT_SCOPE_OPS` (08 A25 D-214 list grows by one).
C. 13-M-SERIES s3: "the Metro Labs logo and the tenant name on top" becomes "the tenant's own logo when it has one, else the Metro Labs logo; the platform console and the sign-in page keep the Metro Labs logo".
D. Web: Provision tenant form gains an optional "Lab logo" file field (PNG/JPEG, 2 MB); new same-origin route `/tenant-logo`.
No DDL, no new table, column, permission, error code, event or bucket: `identity.branding_assets`, `tenant_settings.logo_asset_id`, bucket `identity-assets` and access action `branding_asset.download` are reused.

Backward compatible? yes. Both operations are additive. A tenant without a logo, a logo not yet scanned, or any load failure shows the Metro Labs logo as before.

Tenant/security impact:
- No RLS change. Rows are written by the existing T16 statements under FORCE RLS inside one `withTenantScope(target)` window; the object key is `<tenant_id>/branding/<asset_id>`, built from the path tenant only (`branding_assets__path__ck`, storage `assertTenantPath`).
- New surface 1 (platform upload): super admin only (`platform.tenant.manage`, privileged, aal2). Tenant must exist (404 before any byte is stored); offboarded tenant refused (409). Image is re-encoded, metadata stripped and scanned exactly as on the tenant path (shared function `acceptBrandingImage`).
- New surface 2 (staff read): accepts no tenant id and no asset id; the tenant is the session's; the asset is that tenant's `logo_asset_id` and is looked up with `tenant_id = ctx.tenantId`. Signature images stay excluded (D-26). Every served image is access-logged (P-2). No PHI.
- Browser: `/tenant-logo` takes no input; bytes go through the BFF with the session token (REQ-SEC-068); only PNG/JPEG passed on; `Cache-Control: private, max-age=300`, `Vary: Cookie`, and the sidebar adds `?t=<tenant code>` so two tenants on one browser never share a cache entry. CSP `img-src 'self' data:` unchanged.
- The tenant sees the platform's change: one `settings.change` access-log line (field name only) in the target tenant.

IRD/regulatory impact: none (no billing change).

Alternatives considered:
- A `logo` field inside `TenantProvisionRequest` (multipart provisioning): rejected, it would change an existing JSON operation and its idempotency body hash.
- Lowering the permission of `getBrandingAssetContent` / `getSettings`: rejected, it widens existing operations and still needs the asset id.
- A flag or URL on the session (`resolveSession`): rejected, changes a core auth operation.

Addendum 2026-11-26 (founder: "fix it"): storage wiring, in the same branch.
E. services/api/src/core/pipeline/boot.ts + index.ts (C0-0D): with `STORAGE_PROVIDER=s3_compatible` every TENANT request gets `ctx.storage` / `ctx.uploads` / `ctx.download` bound to its module and its verified claims tenant (the "Next" step of `.orchestra/notes/T0B-STORAGE-1-impl.md`). `STORAGE_PROVIDER=none` or unset keeps the 503 members, so nothing changes until the operator sets the seven `STORAGE_*` names. New ctx member for PLATFORM sessions only: `ctx.tenantFiles(tenantId)` (UUID only) returns the kit of that tenant; used by `uploadBrandingAssetAsPlatform` after it loaded the tenant.
F. services/api/src/core/storage/index.ts: `StorageOptions.raw` (a client built at boot; no key file read per request).
G. services/api/src/core/storage/s3.ts, two defects found by running it against a REAL Supabase Storage server for the first time (it had only met the in-memory fake): (1) presigned requests signed the `x-amz-content-sha256` value as the payload hash; the AWS rule is the literal `UNSIGNED-PAYLOAD`, and the server answered 403 SignatureDoesNotMatch for every put; fixed in `presignV4`, fake and its test follow. (2) the server ignores `if-none-match: *` and overwrites; create-only now looks the object up first (`refuseExisting`, not atomic, keys carry a fresh UUIDv7).
H. Provision form accepts PNG only (the API cannot re-encode JPEG; item 2 below).

Open points for the owner:
1. Storage on the production host is an operator step, not code: one private bucket, S3 protocol keys on the storage service, the seven `STORAGE_*` names on the api containers (`docs/ops/STORAGE.md`). Until then uploads still answer 503 and the sidebar shows the default logo.
2. JPEG re-encode is not available until an image library is pinned (`.orchestra/cr/T0D-17.nonblocking.md` item 3): the API answers 422 for a JPEG. The Provision form therefore offers PNG only; the tenant Settings screen still offers JPEG (not changed here).
3. Proven on a live database (tests/identity/TENANT-LOGO-1.pg.sh, PG17 + all migrations): the platform-scoped insert, the pointer, the access-log line, and that tenant_b claims cannot see tenant_a's row.
4. Changing the logo later from the platform Tenant detail screen is not built (the request was "while creating"); the lab's own admin can already change it in Settings.
5. Found on the real storage server, not fixed here: it does not check the body against a signed `x-amz-content-sha256` (a wrong body is accepted). Server side puts are unaffected (the API hashes what it sends); the unwired direct browser upload (`signUpload`, P-2) must not rely on the storage server for the digest check.
6. Other platform file operations (`uploadIrdAnnexDocument`, `downloadIrdAnnexDocument`) still use `ctx.uploads` / `ctx.storage` of a platform session, which stay unbound (503); they need `ctx.tenantFiles` or a platform prefix decision. The worker's `identity.rescan_upload` job (pending scans) also has no storage. Neither is changed here.
7. Not done: a run of the whole chain in one booted API with a browser (sign in, provision with a logo, see it in the sidebar).

Tests that will prove it:
- services/api/src/modules/identity/service/__tests__/tenant-logo.service.test.ts (32 cases: cross-tenant read and write, role, aal, bad kind, bad file, orphan clean-up, re-scan job).
- apps/web: src/features/platform/__tests__/tenantlogo1.form.test.tsx, src/core/shell/__tests__/tenantlogo1.rail.test.tsx, src/core/shell/__tests__/tenantlogo1.route.test.ts (config `vitest.tenantlogo1.config.ts`).
- Changed expectations, on purpose: `m2.sidebar.test.tsx` (staff sidebar logo is the lab's, was "Metro Labs"); platform operation count 34 -> 35 in `authz-central.platform.test.ts` and `platform-ctx.pipeline.test.ts`.
- Live database: `bash tests/identity/TENANT-LOGO-1.pg.sh` (tenant-logo.live.test.ts, 6 cases). Live storage server: `bash tests/core/STORAGE-KIT-1.pg.sh` (kit.live.test.ts, 3 cases). Both need Docker and are skipped in a plain vitest run.
- Wiring: services/api/src/core/pipeline/__tests__/file-kit.test.ts (16 cases). Changed on purpose: `s3-config.test.ts` (boot.ts now imports the S3 adapter), `s3.fake.ts` / `s3.fake.test.ts` / `s3.stream.test.ts` (signing rule and create-only look-up as the real server needs).

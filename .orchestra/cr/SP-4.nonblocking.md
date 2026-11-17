```
Title: CR-C0-<nnn>: SP-4 api-proxied — C4 07-SECURITY REQ-SEC-034/035 wording: "storage policy" -> ctx.storage adapter
From chunk: C0 (SP-4)      To owner: C4 (C4-frontdesk-billing doc owner)
Type: bug
Blocking? no (doc wording only; no C4 task blocked)
Problem: SP-4 (db/meta/decisions/SP-4.md) decided api-proxied: no end-user policies on storage.objects (08 R10 GoTrue JWT has
  no tenant_id; T0B-12 skips *_storage__create_policies.sql). spec/chunks/C4-frontdesk-billing/07-SECURITY.md:19 (REQ-SEC-034/035
  row) says "first path segment = tenant_id (CHECK + storage policy)". No storage policy will exist, so the row names a control
  that is not there.
Proposed change (exact): in spec/chunks/C4-frontdesk-billing/07-SECURITY.md:19 replace "(CHECK + storage policy)" with
  "(CHECK + `ctx.storage` adapter (08 R12b; SP-4 api-proxied))".
Backward compatible? yes (wording only; C4 already streams files through F21a / B29a with server credentials)
Tenant/security impact: no RLS change, no PHI, no new surface. REQ-SEC-034 enforced by private buckets + ctx.storage adapter
  (first path segment = ctx.tenantId); REQ-SEC-035 unchanged.
IRD/regulatory impact: n/a
Alternatives considered: storage-policies (rejected in SP-4: needs a tenant-bearing token issuer not in 08 R10).
Tests that will prove it: C0-0D ctx.storage adapter tests (cross-tenant path refused); db/tests "authenticated role reads nothing"
  on storage.objects (T0B-12).
```

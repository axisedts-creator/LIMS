# PLATFORM-PROVISION-1 impl (writer)
- contracts/openapi/identity.yaml: TenantProvisionRequest.contract_acceptance (required; tos, dpa; limits 32/120/80; accepted_at = IsoUtc) + the provisionTenant request example gets the field (needed by identity-openapi example test).
- `pnpm codegen` run: api-client-ts/dart, fakes, shared-ts/dart regenerated. Also carries stale drift from earlier yaml changes (quality.ts "excluded", role-packs routes): the committed outputs were behind HEAD yaml.
- web platform: ProvisionForm.tsx (Contract acceptance section, one acceptor+time, default now, UTC), actions.ts (validate + forward snake_case), shared.ts (ACCEPT_MAX, ISO_UTC_RE), ui.tsx (TextInput: datetime-local type, `required` attr) [CONV].
- Ran: api provision-contract 17/17; tenant.service+handlers 176/176; web provision1 26/26; web t26 121/121; codegen.test + identity-openapi 950/953.
- Open: 3 identity-openapi failures NOT mine (GET /v1/identity/role-packs has no example; TRD §5 inventory lists 2 fewer ops than yaml). Not touched.
- Open: accepted_at contract requires exactly 3 ms digits (IsoUtc); service accepts 1-3. Form sends 3.
- Review pass 2026-11-16 20:14: no PLATFORM-PROVISION-1-review.md exists; ruling has no impl items; no impl change. Re-ran verify: api 193/193, web provision1 26/26, t26 41/41, codegen 950/953 (3 = RM-T05, LD-283).
- Not verified: live API call on staging; full web typecheck/lint.

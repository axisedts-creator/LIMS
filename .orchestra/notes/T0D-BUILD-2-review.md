APPROVE
T0D-BUILD-2 review (reviewer, 2026-11-22). Range 13677cf3c..HEAD (test delta per arbiter ruling) plus the full task diff main...HEAD for context.
- Range diff: settings.test.ts:192/:203 now pin tenant-B audit delta (beforeB) instead of an absolute 0; isolation still asserted (A's save adds 0 B rows). Matches ruling; no weakening.
- Names verbatim vs partners.yaml:6038-6147 / PartnerSettings :11144: operationIds, path, x-permission partners.partner.read / partners.partner.manage, x-idempotency none, error codes (validation_failed, forbidden, version_conflict, precondition_required) all from contract.
- Validation = schema limits (INTS/TEXTS/MODES match :11159-11194 and the CHECKs of migration 20261115130000); full replace, unknown fields refused; DEFAULTS = column defaults (migration :34-43).
- Order: staff actor -> IdentityPort.assertRole (before SQL; aal2/mfa_required passes through it as in partner.service.ts) -> If-Match -> body -> FOR UPDATE -> one write; tenant from ctx only, RLS table unchanged (no migration).
- Audit via existing settings__audit trigger; no body value logged or echoed (tests :205, :245). No secrets/PHI in code or tests; synthetic data.
- Owned paths only; contracts/openapi/partners.yaml untouched; 11 files (budget 12).
- Tests cover done_when (3): forbidden, other tenant, defaults on empty tenant, valid update, invalid values, stale/missing If-Match, concurrency; web (4): save toast, error toast, read-only, no-read, defaults. Writer notes: PG17 suite 861 pass, web 15 pass (not rerun by reviewer).

APPROVE

Scope: `git diff 5d1962b8..HEAD` (LD-97/LD-100 writer scope).
- Nine ops wired in handlers/index.ts (B24-B27, B28, B29, B29a, listCreditNotes, getCreditNote); createPaymentIntent/verifyPaymentIntent stay `notYet`.
- Query names match contracts/openapi/billing.yaml verbatim (fiscal_year_bs, issued_at_from/to, centre_id, actor_membership_id, action, occurred_at_from/to, invoice_id).
- Fail-closed bind (tenantId/actor/tx) as in credit.handlers.ts. B29a goes through core ctx.download.stream (DownloadInput shape matches core/storage/download.ts): attachment, nosniff, no-store, no URL; access_log written by the helper; privileged + tenant-prefix + bucket checks kept in export.service locate().
- SQL fully parameterised, tenant bound first, `::uuid[]` cast on ANY. No PHI in logs, no secrets, only C4-owned paths.

Checks run:
- handlers/__tests__/register.export.handlers.test.ts: 41/41 pass.
- worker src/jobs/billing: 182 pass, 31 skipped.
- tsc: 0 errors under src/modules/billing (pre-existing errors in contracts/ports, packages/shared-ts only).
- api src/modules/billing: 31 failures, all in BL-T22 probe files (crossTenant, uploads, alerts.rules), the set LD-98 assigns to test changes. The billing:getBillingExportContent probe returns common.internal because probe.kit ctxFor has no download.stream stub. LD-98 item (1) adds that stub. It is not a BL-T15 defect: the handler correctly fails closed when the stream helper is missing.

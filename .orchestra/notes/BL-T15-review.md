APPROVE
Scope reviewed: tester commit 5940f25a (13516a1e..HEAD) plus the writer's LD-97 working-tree changes. These are uncommitted: handlers/{register,export}.handlers.ts are new, and index.ts, invoice.handlers.ts, creditNotes.repo.ts, export.service.ts and invoiceRead.service.ts are modified. They must be committed with this approval.
- Nine ops wired in handlers/index.ts exactly; createPaymentIntent/verifyPaymentIntent stay notYet (LD-97). Names/params match contracts/openapi/billing.yaml (credit_note_id, export_id, invoice_id, fiscal_year_bs, Cursor, Limit).
- Fail-closed bind (tenantId/actor/tx -> auth.unauthenticated) same as credit.handlers; tenant from ctx only; SQL fully bound, tenant_id named, `ANY($2::uuid[])`.
- B29a: privileged + tenant/ready/expiry/prefix checks in locate() before any read; bytes only via core ctx.download.stream (attachment, nosniff, no-store, access_log row by the helper); missing helper -> common.internal; never a URL. B28 -> 202.
- No PHI in logs, no secrets, only C4-owned paths; no contracts/openapi edit; no probes/pending.json in this lane.
Ran: api 5 files / 131 tests pass (register/export service, export.permissions static, registers.order, register.export.handlers, invoiceRead); worker export.render + xsdSubset 48 pass. NOT run: register.live (needs DB env), real xmllint XSD validation.
Carry-over (not a BL-T15 code defect): openapi CancelledInvoiceRow lacks cancelled_by (US-BL-12.2) -> CR to C0; no non-test code calls core createDownload to wire ctx.download (core/C0 gap, same for identity/settings users).

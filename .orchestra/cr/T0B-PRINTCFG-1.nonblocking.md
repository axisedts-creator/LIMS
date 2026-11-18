Title: CR-C0-PRINTCFG-1: ports needed to wire the print profile features end to end (sign-off chain, signature asset check, bill patient age/sex)
From chunk: C0 (T0B-PRINTCFG-1)            To owner: C0-0C (ports / contracts), C5 lab, C2 identity, C4 billing agree
Type: port + api
Blocking? no (the pure rules, renderer and handlers are done and tested; only these wirings wait)

Problem:
1. done_when (2) "the signature block lists only pathologist sign-offs of lab.result_signoff": reporting reaches lab only through LabPort (contracts/ports), and LabPort has no
   method returning the sign-off chain snapshots. buildReportDocument now takes `signoffs` (domain/document.ts, pathologist only, tested), but assembly.service cannot fetch them
   without SQL against the lab schema (forbidden). Until then reports keep the legacy approvers path.
2. done_when (6) "reject an asset id that is not an image of the same tenant": no port returns metadata (tenant, mime type) of an uploaded file by id. IdentityPort.readBrandingAsset
   excludes kind 'signature'; readSignatureImage is system-only and keyed by membership. upsertSignatoryProfile therefore refuses EVERY signature_asset_id (fail closed,
   assertImageAsset(undefined)) until a port exists (T0B-STORAGE-1?).
3. done_when (4) plain bill "patient name and age and sex": InvoicePrint.document has buyer (Party) only, no age/sex. The renderer template accepts `data.patient {name, age_text, sex}`,
   but printInvoice cannot fill it without a FrontdeskPort read + a contract field.
4. Worker render_print: who resolves the print profile (branch + recipient, resolvePrintProfile) and passes RenderRequest.print_profile, and how a previewPrintProfile job
   (payload carries print_profile + document_kind, template_version_id NULL) is rendered: services/worker is outside this chunk's paths.

Proposed change (exact, to be confirmed by owners):
1. LabPort.getResultSignoffs(ctx, { resultVersionIds: Uuidv7[] }) -> SignoffSnapshot[] (fields of lab.result_signoff, camelCase, as in reporting/domain/document.ts SignoffSnapshot).
2. IdentityPort.getAssetMeta(ctx, { assetId }) -> { tenantId, mimeType, kind } | not_found (or the STORAGE-1 file port equivalent).
3. InvoicePrint.document.patient?: { name, age_text, sex } (billing.yaml, optional) filled from FrontdeskPort.PatientDemographics (purpose print).
4. Worker: render_print reads reporting.print_profile (resolvePrintProfile) per document kind / branch / recipient and passes print_profile; preview jobs use template-preview.
Backward compatible? yes (all additive / optional).
Tenant/security impact: reads stay tenant scoped through ports; no new public surface.
Alternatives considered: direct SQL on lab / identity tables (forbidden by 04-CHANGE-REQUESTS §1).
Tests that will prove it: assembly test with a level 3 chain; signatory upsert accepting a same-tenant PNG and refusing others; plain bill PDF showing age/sex from printInvoice.

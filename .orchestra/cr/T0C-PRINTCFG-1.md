Title: CR-C0-PRINTCFG-1: which permission gates invoice and credit_note print profiles
From chunk: C0-0C            To owner: lead (ruling), then C0-0B (gate) / C0-0C (contract text)
Type: api
Blocking? no for T0C-PRINTCFG-1 (contract ships with both codes stated); yes for T0B-PRINTCFG-1 handler gate choice.
Problem: brief done_when (4) says report and signer profiles use reporting.settings.manage, and invoice and credit_note profiles use "the permission the billing settings operations already use" (billing.settings.manage). An operation has one x-permission, so listPrintProfiles, upsertPrintProfile and previewPrintProfile carry x-permission reporting.settings.manage and the description also requires billing.settings.manage for invoice/credit_note. contracts/permissions.yaml:95 gives billing.settings.manage to [tenant_admin, finance]; :144 gives reporting.settings.manage to [tenant_admin, lab_manager]. A finance user is refused at the gate and cannot set the bill header/footer or the plain bill profile.
Proposed change (exact), choose one:
 (a) gate accepts either code per document_kind: report -> reporting.settings.manage; invoice, credit_note -> billing.settings.manage. Contract: x-permission stays reporting.settings.manage plus a documented alternative (needs a gate rule "any of" or a new extension name; lead to name it, no name invented here); handler checks per document_kind.
 (b) ruling keeps both codes (reporting.settings.manage AND billing.settings.manage for invoice/credit_note); finance-only users need lab_manager or tenant_admin to manage bill profiles. No contract change beyond removing the "until ruled" sentence.
Backward compatible? yes, both options (operations are new, pending in reporting index.ts).
Tenant/security impact: no RLS change, no PHI, no new permission code. (a) widens who may edit bill print profiles to finance; (b) keeps least privilege but blocks finance.
IRD/regulatory impact: plain_bw bill lines unchanged either way.
Alternatives considered: new permission code (refused: brief forbids new codes); add reporting.settings.manage to finance in the role pack (widens finance to report templates, not asked).
Tests that will prove it: printcfg1-openapi test pins the chosen text; T0B-PRINTCFG-1 handler test: finance user upserts an invoice profile (200 under (a), 403 under (b)) and is refused a report profile (403 both).

Title: CR-C0-PARTYSET-001: contract names missing for the T0B-PARTYSET-1 runtime effects (access action, list masks, warning, interest line)
From chunk: C0 (lane C0-0I, T0B-PARTYSET-1)            To owner: C0-0C (contracts)
Type: api | port | schema (code set)
Blocking? no (handlers implemented; the items below fail closed or are additive until ruled)
Problem (done_when 3 and 5 of T0B-PARTYSET-1, tests in .orchestra/notes/T0B-PARTYSET-1-tests.md "CONTRACT GAPS"):
 1. revealPartyIdNumber must write one access audit event, but audit.g_cs_access_actions / contracts/ports/generated/access-actions.ts has no action for it.
    The handler writes action `party_id_number.reveal` (entityType party_id_number, detail party_kind + field, never the value); until the code is registered the
    audit.access_log FK refuses it and the reveal answers 500 (fail closed: no value without an audit row).
 2. PartnerAdminSummary (listPartners) and DoctorSummary (listDoctors, searchDoctors) carry no tax_number / national_id_number; the tests require the MASKED
    values on list rows. Code adds them masked; with LIMS_CORE_RESPONSE_VALIDATION=on (dev) the response check refuses the extra keys until the schemas gain them.
 3. BillingCommandPort.assertCreditAllowed is Promise<void>; the overdue warning resolves { warnings: [{ code: 'invoice_overdue', days_overdue }] }. The warning code
    `invoice_overdue` is not in a registry.
 4. CreditPartyStatement rows have no field for the interest line; code adds `interest_paisa` (integer paisa, only when > 0, never in closing_balance).
 5. The account ledger needs an account particular for the penalty charge: code uses the tenant's ACTIVE billing.account_particulars row with code
    NON_COMPLIANCE_PENALTY (refused when none) and payment_mode `penalty`, centre = the partner's receiving centre (credit party: its partner's). No seed exists.
Proposed change (exact):
 1. contracts access-action registry + db/seeds/003_audit__g_cs_access_actions.sql: add `party_id_number.reveal` (display "Government ID number revealed").
 2. partners.yaml PartnerAdminSummary and catalog.yaml DoctorSummary: add `tax_number` / `national_id_number` (string, maxLength 64, masked) as in PartnerAdmin / Doctor.
 3. contracts/ports/BillingCommandPort.ts: assertCreditAllowed(...): Promise<void | { warnings: Array<{ code: 'invoice_overdue'; days_overdue: number }> }>.
 4. billing.yaml CreditPartyStatement row: `interest_paisa` integer >= 0, optional, description "statement line only, never posted (LD-321)".
 5. founder / accountant step: seed or create the NON_COMPLIANCE_PENALTY particular per tenant (or name another code); confirm payment_mode `penalty`.
Backward compatible? yes (all additive / optional).
Tenant/security impact: none new; (1) closes an audit gap (REQ-SEC government id access); (2) values stay masked.
Alternatives considered: reuse `data.export` for the reveal (rejected: wrong meaning in the audit trail); omit list masks (rejected: tests and brief "every list").
Tests that will prove it: partners/__tests__/partyset/masking.test.ts, catalog/__tests__/partyset/doctor.test.ts, billing/__tests__/partyset/runtime.test.ts, penalties.test.ts.

Title: CR-C0-MISREPORTS2-001: "two level" has no data source (no parent / sub party link exists); the Hold exclusion has no join to the invoice base; the dispatcher omits only referral_incentive
From chunk: C0 (lane C0-0J, T0B-MISREPORTS-2, tester)            To owner: C0-0C (contracts) / lead
Type: schema | api
Blocking? partly: the rate source, base, gate, tds, headers, isolation and schedule rules are tested and unblocked; ONLY the rule that makes a party level 2 (and fills parent_party_id / parent_party_name) is open.
Problem:
 1. A39-4 says "two level means a parent party and its sub party, from the partners hierarchy of T0C-SALES-1". The T0C-SALES-1 hierarchy (migration 20261117210000) is a tree of SALES REPRESENTATIVES
    (partners.sales_representative.manager_id) plus partners.party_sales_assignment (party -> representative, effective dated). There is no party -> parent party column anywhere
    (catalog.credit_parties, partners.partners, partners.party_commercial_setting have none). A party's representative has one manager, but a manager has many assigned parties, so
    "the parent party" cannot be derived one to one. The old moved test assumed a parent_party_id column on the settings table: false in this tree.
 2. A39-4 "held ledger entries are excluded", done_when (2) "ledger items on Hold are excluded". The base is billing.invoices (M33: gross - discount - credited, issued only). Held status exists only on
    billing.account_ledger_entries (party account journal: credit/debit, no invoice link). Nothing joins the two, so there is nothing for the exclusion to act on unless the base includes ledger debits.
 3. schedule.service.ts dispatchDueSchedules omits only the literal 'referral_incentive' when the flag is off; A39-2 requires the same for the two money codes.
Proposed change (exact):
 1. Lead rules the parent rule. Suggestion: parent party of P = the credit party assigned (party_sales_assignment, effective on the period end) to the manager of P's representative when exactly one such party
    exists; level 1 otherwise (parent_party_id '' and parent_party_name ''). Alternative: add parent_credit_party_id to partners.party_commercial_setting (T0C change, additive).
 2. Confirm the base stays invoice based and held account entries never enter it (tested as neutrality: holding / not holding a ledger entry changes no figure), or define the ledger term.
 3. Implementer (not a CR): omittedRun in dispatchDueSchedules lists the codes whose registry flag is set (getReport(c).flag), not the literal code; pinned by service/__tests__/schedule.dispatch.money.test.ts.
Backward compatible? yes. Tenant/security impact: none new (flag, permission, aal2 and access log unchanged).
Alternatives considered: pin an invented rule in the tests (rejected: Names and rules are not invented); stop (rejected: the rest is testable).
Tests that will prove it: misreports/commission.live.test.ts ("level / parent shape" pins shape only; a rule test is added after the ruling).

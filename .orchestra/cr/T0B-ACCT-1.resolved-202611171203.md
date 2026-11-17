Title: CR-C0-ACCT-1: access-log action codes for lab accounting ledger entry create and reverse
From chunk: C0 (task T0B-ACCT-1, lane C0-0B)            To owner: C0-0C (03-IC §13.1 + codegen seed)
Type: schema
Blocking? yes — T0B-ACCT-1 done_when (6) "every write writes an audit event"; test entries.test.ts "every create writes an audit record naming the entry" cannot pass.

Problem (what you cannot do today, with the user story / acceptance criterion it serves):
LD-313 lab accounting ledger writes (createAccountEntry, x-permission billing.account_entry.create; reverseAccountEntry, x-permission billing.account_entry.reverse; contracts/openapi/billing.yaml T0C-ACCT-1 block) must each leave an audit event (T0B-ACCT-1 done_when 6). audit.audit_log is written only by app.tg_row_audit and migration 20261117120000_billing__add_lab_accounting.sql deliberately has no row audit trigger on billing.account_ledger_entries (free text payment_details may hold personal data). audit.access_log.action is FK to audit.g_cs_access_actions = C0 base list ∪ 03-IC §13.1 (05-SCHEMA §3.7, line 286); no code fits a ledger entry create or reverse, and 03-IC §13.1 forbids any other string-literal action in services/**.

Proposed change (exact):
03-IC §13.1 YAML block, new group after "# C4":
```yaml
# C0 / LD-313 lab accounting (CR-C0-ACCT-1)
- account_entry.create              # "Account ledger entry posted"
- account_entry.reverse             # "Account ledger entry reversed"
```
Regenerate db/seeds/003_audit__g_cs_access_actions.sql with tools/codegen/gen-access-actions.ts (plus a seed migration or re-seed so the codes exist in deployed DBs); add the two codes to the 05-SCHEMA §3.7 hand list.
API use (T0B-ACCT-1): in the posting transaction, ctx.audit.access({ action: 'account_entry.create' | 'account_entry.reverse', entityType: 'account_ledger_entry', entityId: <entry id> (for reverse: the new reversal entry id, original id in detail.reverses_entry_id), outcome: 'allowed' }); detail holds ids only, never comments, bank_name, reference_no or payment_details.

Backward compatible? yes — additive rows in a coded set; no existing code renamed or removed.
Tenant/security impact: no RLS change, no new PHI field, no new public surface. Strengthens REQ-SEC-057 (append-only ledger, tamper evidence) with who-did-what; access_log.detail stays ids/counts only (05-SCHEMA §3.6 line 284, logger denylist).
IRD/regulatory impact: none (lab accounting records only; no invoice or CBMS change; LD-313 (e) no money moves).
Alternatives considered:
- (b) row audit trigger on billing.account_ledger_entries excluding free text: app.tg_row_audit('bank_name','reference_no','payment_details','comments') in a follow-up billing migration. Works without a code-list change but reverses the T0C-ACCT-1 deliberate "no row audit on the ledger" decision (same as billing.ledger_entries) and adds one audit row per entry to audit_log growth (06 plan R-5).
- Reuse receipt.print / statement.view: rejected, misstates the action.
- Drop the requirement: rejected, contradicts done_when (6).
Tests that will prove it:
- T0B-04 seed equality test (base list ∪ §13.1) green with the two codes.
- P-3 CI check (tools/codegen/check-access-actions.ts) green on the accounts service.
- entries.test.ts:97 "every create writes an audit record naming the entry" unchanged and green; a matching reverse case asserting one access_log row with entity_id = reversal entry id and none of the free text.

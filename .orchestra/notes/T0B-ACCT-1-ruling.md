CR_NEEDED — the spec itself is contradictory/missing (write the CR text into `.orchestra/cr/T0B-ACCT-1.md` using spec/program/04-CHANGE-REQUESTS.md)

Reasons (disputed test: services/api/src/modules/billing/__tests__/accounts/entries.test.ts:97-110):
1. The test is faithful to the task: brief done_when (6) "every write writes an audit event; no personal data in logs" (.orchestra/inbox/T0B-ACCT-1-arbiter.md:18). It accepts either audit table, so it is not over-specified.
2. audit.audit_log is closed to the API: rows only via app.tg_row_audit; migration main:db/migrations/20261117120000_billing__add_lab_accounting.sql:11-12 and :324 deliberately put NO row audit trigger on billing.account_ledger_entries (free text payment_details).
3. audit.access_log.action has FK to audit.g_cs_access_actions (spec/chunks/C0-foundation-contracts/05-SCHEMA.md:284, :909); the seed is exactly the C0 base list ∪ 03-IC §13.1 (05-SCHEMA.md:286 "chunks add codes by CR"; spec/program/03-INTERFACE-CATALOG.md:3283-3370). No code there names a ledger entry create/reverse; reusing receipt.print / statement.view would misstate the action.
4. 03-IC:3372 forbids any `action` in services/** not in the seed (CI P-3 check). So done_when (6) cannot be met without a spec addition: contradiction between the brief and the seeded code list.
5. Contract main:contracts/openapi/billing.yaml (T0C-ACCT-1 block, from :4418) carries no audit text for these ops, so nothing else settles it.
6. Recommended fix: CR option (a), two additive access-action codes; the test then passes unchanged with ctx.audit.access({action, entityType:'account_ledger_entry', entityId, outcome:'allowed'}) and no detail. Test stays as is; implementation waits for the CR.

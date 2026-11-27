Title: CR-C13-016: port method for the penalty ledger entry (partners must stop importing the billing accounts service)
From chunk: C13            To owner: C0-0C (implementing chunk C4 billing must agree)
Type: port
Blocking? no — the code works today through a direct import; this CR removes a 02-CONVENTIONS §1.3 violation (REQ-ARCH-076).
Status: DRAFT, not filed; IMPLEMENTED in the working tree on 2026-11-25 on `BillingPort` (not BillingCommandPort: partners is already a listed BillingPort consumer in PORT_CONSUMERS, so no 03-IC change is needed). Owner sign-off still required. CR number is the next free one found by grep (highest seen: CR-C13-015); owner to confirm. File name is not an orchestra task id.

Problem (what you cannot do today, with the user story / acceptance criterion it serves):
T0B-PARTYSET-1 done_when (6): charging a non-compliance event posts exactly ONE debit account ledger entry on the credit party ledger, in the same transaction, and stores its id on the event.
`services/api/src/modules/partners/service/partyset.service.ts:10` imports `createAccountsService` from `../../billing/service/accounts.service.js` and calls `accounts.createEntry(ctx as never, {...})` at line 314.
No port exposes an account ledger entry: `contracts/ports/BillingCommandPort.ts` and `contracts/ports/BillingPort.ts` have no such method. The import is frozen in `tools/lint/tests/tree-cross-module.baseline.json` and cannot be removed without a contract.

Proposed change (exact): add to `contracts/ports/BillingCommandPort.ts` (name and shape are a PROPOSAL for the owner to fix):

  /** Posts one account ledger entry (T0B-ACCT-1 rules: same validation, same audit as the accounts endpoint). Runs in the caller's
   *  transaction (02-CONVENTIONS §7, port rule: ctx.tx, never its own). Any failure throws and the caller's transaction rolls back. */
  recordAccountEntry(ctx: RequestContext, input: {
    centreId: Uuidv7; partyKind: 'credit_party'; partyId: Uuidv7; entryDate: string /* YYYY-MM-DD, tenant date */;
    accountParticularId: Uuidv7; entryType: 'debit'; amount: Money; paymentMode: Code; comments?: string;
  }): Promise<{ entryId: Uuidv7 }>;

Implementation in C4: delegate to the existing `createEntry` of `services/api/src/modules/billing/service/accounts.service.ts` (no new SQL).
01-CHUNK-MAP §5 lists `BillingCommandPort` consumers as "C4 (frontdesk only)": that row gains C13. If the owner prefers not to widen it, the same method on `BillingPort` is acceptable to C13.

Backward compatible? yes — additive method; no existing caller changes. Fakes in `packages/fakes` gain one method.
Tenant/security impact: no RLS change, no new PHI field, no new public surface. The caller's permission check (penalty permission in partners) stays where it is; billing applies its own entry validation. Ledger writes stay inside the billing module.
IRD/regulatory impact (billing changes only): none to invoice numbering or immutability — an account ledger entry is not a fiscal invoice (04 L6 unaffected). Owner to confirm.
Alternatives considered:
  (a) Event from partners consumed by billing — rejected: done_when (6) needs the entry id in the same transaction.
  (b) Keep the import — rejected: 04-CHANGE-REQUESTS §1 "never work around a missing contract".
  (c) Move the charge operation into billing — larger change of chunk ownership.
Tests that will prove it:
  - Port contract test: `recordAccountEntry` inside a transaction that then rolls back leaves no ledger row.
  - Existing partyset charge tests stay green with the import removed (charge once, repeat answers first result, waived refused).
  - `tools/lint/tests/tree-cross-module.test.mjs`: the partners → billing entry leaves the baseline.

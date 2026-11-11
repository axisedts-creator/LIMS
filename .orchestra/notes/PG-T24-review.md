APPROVE

PG-T24 review (diff 70b0f99e..HEAD).
- Scope: only `services/api/src/modules/payments/__tests__/contract/consumers.contract.test.ts` + own notes. Owned paths only. No impl change.
- Ran `.orchestra/notes/PG-T24-verify.cmd`: 2 files passed, 48 passed, 3 skipped (refund cases in PaymentProviderPort.real.contract.test.ts, owned by PG-T14, not this suite).
- Coverage vs ACs: 11.1/11b.1 (allowlist accept, URLs + actor stored, amount from balance, amount input rejected), 11.2/11b.2 (eSewa+Khalti 303 to returnUrl with intent_id + outcome, ledger call inside settle), 11.3 (edited outcome=settled changes nothing), 11.4/11b.4 (patient/portal/anonymous/service actors get auth.forbidden on all 5 methods, no side effects), 11b.3 (getIntent with no gateway call), 11b.5 (C0 stub -> payments.gateway_not_available). Plus ST-14 tenant B -> common.not_found and a shared open-intent slot.
- Names: error codes, columns and reason codes all exist in spec (03/08/C15 docs). Nothing invented.
- Synthetic IDs/URLs only. No PHI, no secrets. RLS/permission gate/idempotency/rate tier: no new surface in this task.
- Not provable here (noted by tester, accepted): core x-permission gate, real RLS, real C16/C6 workers.

# BL-T08 impl (writer)
Files: service/{ledger.service,cash.service,ledgerRead.service,ledgerDto}.ts, handlers/ledger.handlers.ts (+index.ts wiring, ifMatch exported), repository/{ledger,cashSessions,balances,invoices,index,paymentMethods(new)}; invoiceRead.service.ts only gained `export` on shared helpers.
Result: after ruling (BL-T08-ruling.md, test 2 revised) 148/148 BL-T08 tests pass; billing suite 704 passed / 45 skipped / 0 failed. No code change needed.
[CONV] Idempotency-Key -> ledger key `<order_id>:pay:<key>`; order_balances locked before the replay lookup and the RC counter; cash session opened by INSERT .. ON CONFLICT DO NOTHING + re-read (no aborted tx); cash variance_paisa = cash methods only.
[CONV] B16 registration_no/patient_display = first invoice no./buyer name; B18 skips gateway + refund rows; other users' display_name = "Staff user" (CR .orchestra/cr/BL-T08.nonblocking.md).
Not verified: real SQL/RLS/CHECKs (no live DB run), concurrency, permission gating; no eslint configured in services/api; tsc clean for billing sources (pre-existing contracts/ import errors elsewhere).

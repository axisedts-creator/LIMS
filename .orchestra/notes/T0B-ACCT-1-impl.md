# T0B-ACCT-1 impl (LD-313, LD-310; pass 2 = LD-324; pass 3 = LD-328)
- Files (pass 1): billing/repository/accounts.repo.ts, service/accounts.service.ts, handlers/accounts.handlers.ts (new); handlers/index.ts; config.ts (+accountEntryMaxPaisa); docs/runbooks/environment.md.
- Pass 2: db/seeds/003_audit__g_cs_access_actions.sql + contracts/ports/generated/access-actions.ts regenerated (account_entry.create/.reverse, now in committed 03-IC §13.1); create/reverse call ctx.audit.access, ids only in detail. No row audit trigger.
- Pass 3 (LD-328): 12 ACCT-2 503 stubs deleted from handlers/index.ts; the 12 ids listed in billing/index.ts pendingOperations (core answers 501). Seed already matches 03-IC, no spec edit.
- [CONV] receipt ACC-nnnnnn = per tenant max(receipt_seq)+1 under pg_advisory_xact_lock; reversal dated today (tenant tz); bank_name required for bank_transfer/cheque; user_pocket party 404 (T0B-ACCT-2).
- Runs (pass 4, after arbiter TESTS_WRONG boot fix): tsc clean; boot.test alone 9/9; whole billing PG17 2013 pass / 4 fail; all accounts tests + billing crossTenant probes green. No product change in pass 4.
- OPEN: 4 crossTenant fails = frontdesk createCustomFieldDefinition/updateCustomFieldDefinition/updateCoupon/updateIcdCode (T0B-REGAPI-2 parity ops, out of scope per ruling).

# BL-T16 impl (writer)
Files: NEW services/worker/src/jobs/billing/consumers/index.ts; EDIT services/worker/src/jobs/billing/index.ts (subscriptions = both handlers).
- [CONV] Seam as the tester assumed: createBillingConsumers({repo,counter,events}) + lazy production onIntentSettled/onCollectionSynced; tenant from ctx only, envelope.tenant_id != ctx.tenantId = warn + skip (no write, no retry).
- [CONV] Gateway: BillingPort.recordGatewayPayment with allowExceedsDue=true (replay of an existing row = no write; overpayment item raised there). Home: ledger.recordPayment(home_collection, key=client_mutation_id, issueReceiptNo=false) per payment, same tx.
- [CONV] Home items raised only on a non-duplicate row: home_payment_exceeds_due (excess over due), home_payment_method_inactive (payment amount; method missing or !is_active). Never throws for either.
- [CONV] A reference the ledger would refuse (card digits/control chars/>100) is dropped so collected money is never blocked.
- Result: consumers.test.ts 23/23; services/worker/src/jobs/billing 49 passed, 17 live skipped; tsc clean for jobs/billing.
- Open: recordGatewayPayment/recordPayment need ctx.ports.IdentityPort; confirm the C0 consumer wrapper's JobContext supplies `ports` (tests inject it). Retry-vs-dead-letter for idempotency_key_reused / order-not-invoiced left to wrapper (spec silent).

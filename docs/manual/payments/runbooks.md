# Payments: operator runbooks and alerts

## RB-1 Enable a gateway for a lab

1. Obtain the merchant credentials from the lab over a secure channel (eSewa product code and secret; Khalti live secret and website URL). Never by chat or email.
2. The tenant admin enters them on `/payments/settings`, then presses **Test connection**.
3. Make a UAT payment in staging with the UAT keys. eSewa cannot verify the secret without a real payment.
4. Only then switch the production account on.

## RB-2 Held payment

1. Open the review queue (`/payments/review`).
2. Press **Re-check**.
3. If the payment is still held, contact the provider with the `gateway_txn_ref` (Khalti: "hold, and contact Khalti").
4. Resolve the payment with a reason.

Alerts: `PaymentsHeldForReviewStale` (held longer than 24 h), `PaymentsOpenIntentsPastDeadline`.

## RB-3 Amount mismatch alert

Alert: `PaymentsAmountMismatch` (page).

1. Do not settle the payment.
2. Compare the provider dashboard with the payment.
3. Record the evidence in the resolve note.
4. Escalate to the LIMS provider security team if tampering is suspected.

## RB-4 Reconciliation failed or not run

Alerts: `PaymentsReconciliationMissing` (page), `PaymentsReconciliationStalled`, `PaymentsCriticalFinding` (page), `PaymentsGatewayErrorRatio`.

1. Check worker health and gateway reachability.
2. Press **Run now** on `/payments/reconciliation`.
3. If a provider is down, findings `gateway_unreachable` clear on the next successful run.

## RB-5 Gateway refund

1. Finance person A requests the refund.
2. Finance person B approves it (two-person rule).
3. Refund the patient in the provider dashboard.
4. Confirm on `/payments/refunds` with the provider reference.
5. If the refund is held, re-check the next day.

## RB-6 Secret rotation and staff departure

1. The provider issues a new secret.
2. The tenant admin replaces it on `/payments/settings`.
3. Revoke the old secret at the provider (REQ-SEC-058).

Alerts: `PaymentsCredentialRejected` (the provider refused the key), `PaymentsCallbackSignatureInvalid`.

## RB-7 KEK rotation (C1)

Done by the platform team as specified in CR-C15-008 item 5. Merchant secrets are re-encrypted by the worker; no operator action on the payments screens.

## RB-8 Static-QR worksheet

Daily: compare the bank statement Fonepay credits with the worksheet on `/payments/static-qr`. Discrepancies are fixed in C4 (reversal or new manual entry).

## RB-9 Go-live checklist

1. PG-T21 and PG-T22 UAT results are recorded.
2. Every UNVERIFIED item in the product requirements (section 9) is closed or accepted by the founder.

## Alert index

| Alert | Severity | Runbook |
|---|---|---|
| `PaymentsAmountMismatch` | page | RB-3 |
| `PaymentsCriticalFinding` | page | RB-4 |
| `PaymentsReconciliationMissing` | page | RB-4 |
| `PaymentsReconciliationStalled` | warn | RB-4 |
| `PaymentsHeldForReviewStale` | warn | RB-2 |
| `PaymentsCallbackSignatureInvalid` | warn | RB-6 |
| `PaymentsGatewayErrorRatio` | warn | RB-4 |
| `PaymentsCredentialRejected` | warn | RB-6 |
| `PaymentsOpenIntentsPastDeadline` | warn | RB-2 |

# Payments: operator screens

Online payments through eSewa and Khalti. Fonepay live payments are not available yet; Fonepay QR payments recorded at the counter are compared with the bank statement on the worksheet screen.

## Payment review queue: `/payments/review`

Lists payments that need a person: by default those under review (`held_for_review`). Filter by status, gateway, hold reason, created date (31 days at most) and centre. Open a row to see the payment detail.

## Payment detail: `/payments/intents/{intent_id}`

Shows the status, amount, gateway, the provider reference (`gateway_txn_ref`), a timeline, provider checks, callbacks and refunds. Actions need the `payments.intent.resolve` permission:

- **Re-check with provider**: asks the provider for the current status.
- **Mark as paid**: only if the provider confirms the payment with the exact amount.
- **Record although it exceeds the due**: for the hold reason `exceeds_due`; Finance gets a review item to refund the difference.
- **Mark as failed**: only if the provider confirmed that no money was taken.
- **Cancel payment**: the provider is checked first; if the patient already paid, the payment is recorded instead.
- **Request refund**: for paid payments, with `payments.refund.request`.

## Refunds: `/payments/refunds`

Lists refunds by status (waiting for approval, approved, in progress, under review, completed, failed, rejected). A second person must approve a refund that you requested (see RB-5). Actions: approve, reject, confirm refund done, re-check, mark refund failed.

## Gateway reconciliation: `/payments/reconciliation`

Tabs **Runs** and **Open findings**. **Run now** starts a manual run; only one run can be active at a time. Critical findings page the on-call person (see the alerts in `runbooks.md`).

## Fonepay QR worksheet: `/payments/static-qr`

Daily comparison of the Fonepay credits on the bank statement with the system total for a date and centre. Enter the statement total and reference; a note is required when the difference is not zero. See RB-8.

## Payment gateways (settings): `/payments/settings`

One card per gateway for this environment (UAT or Production): enable, merchant code or website URL, secret key, **Test connection**. The secret key is never shown after saving; only the date it was set and a short fingerprint. The card "Refunds and labels" sets the two-person refund threshold, the Khalti order label and nightly reconciliation. See RB-1 and RB-6.

# Payment detail

## Purpose
Shows one online payment: its status, amount, provider references, and the full history of what happened. Use it to decide what to do with a payment that is under review. A payment is shown as "Paid" only when the provider has confirmed it and the server has recorded it.

## Facts
Order, Centre, Amount, Provider reference, Provider transaction, Created, Expires, Paid at, Verified amount, Verification, Hold reason, Ledger entry and Refunded. The tabs show the Timeline of status changes, the Provider checks we made, the Callbacks the provider sent, and any Refunds. No tokens, links or raw provider messages are shown.

## Actions (only with permission to resolve payments)
- **Re-check with provider** (Alt+C): asks the provider again. Allowed while the payment is Started, Waiting for provider or Under review. If it was checked a moment ago, wait a few seconds.
- **Mark as paid**: the provider is checked again. The payment is marked paid only if the provider confirms it with the exact amount. Choose a reason.
- **Record although it exceeds the due**: offered when the provider took more than the order owed. The full amount is recorded and Finance gets a review item to refund or keep it as advance.
- **Mark as failed**: only if the provider confirmed that no money was taken. Choose a reason; the reason "Other" needs a note.
- **Cancel payment**: for payments that are Started or Waiting for provider. We check with the provider first; if the patient already paid, the payment is recorded instead.
- **Request refund**: for paid payments, with permission to request refunds.

## If something goes wrong
"This payment changed. Reload to see the latest." means someone else changed it. Reload and try again. "The provider has not confirmed this payment" means it cannot be marked paid yet; re-check later.

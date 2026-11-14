# Orders and patients (screens `/frontdesk/orders/<id>` and `/frontdesk/patients/<id>`)

This page explains what you can do on an order and on a patient record. It mirrors the in-app help.

## Order (`/frontdesk/orders/<id>`)

- **Items** – add tests (a quote is shown first) or remove a test (a reason is required; Finance issues a credit note if it was invoiced).
- **Billing** – see invoiced, paid, credited and balance due; record a payment.
- **Attachments** – upload a request form. It is scanned first; only clean files can be previewed.
- **Cancel order** – pick a reason. A cancelled order cannot be reopened. If money was paid, Finance issues a credit note and refund.

## Patient (`/frontdesk/patients/<id>`)

- **Edit demographics** – name, phone, email, address. The phone is masked on screen.
- **Update consent** – data processing, SMS, WhatsApp, email, sharing with the referrer.
- **Visits** – past orders; open one from its registration number.
- **Anonymise** – needs MFA and no open order. Personal details are removed; orders and invoices are kept for the legal retention period. It cannot be undone.

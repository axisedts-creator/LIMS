# CBMS status (screen `/billing/cbms`)

CBMS is the IRD's Central Billing Monitoring System. This page explains what the CBMS screen shows today. It mirrors the in-app help for the screen.

## Current status: connection not configured

The lab's CBMS connection is not configured. Invoices, credit notes and invoice cancellations are recorded in full, and each one waits in the queue. Nothing is sent. Every waiting document shows this exact label:

> Not sent — CBMS connection not configured

The label appears on the CBMS screen, in the CBMS column of `/billing/invoices`, and on the invoice page. It describes what the lab's system did. It is not a statement by the IRD about any invoice, and it does not mean any document is accepted or rejected.

## States

| State | Meaning |
|---|---|
| Not sent — CBMS connection not configured | Recorded, waiting for a connection. |
| Not required | The lab's tax settings say real-time CBMS is not needed. |
| Sent | The CBMS service accepted the document. Appears only once a live connection exists. |
| Failed | The CBMS service refused the document. Finance reviews it; people with the retry permission see a Retry button. |

## Columns

Kind, Document no, Last attempt, State, Attempts, Last outcome, Actions.

## Related

- Invoices cannot be edited or deleted. To correct one, cancel it with a reason; a credit note is issued automatically, and that credit note gets its own CBMS row. See `/billing/invoices`.
- Whether CBMS is required is a tax-registration setting kept by your administrator. See `/billing/settings`.
- Failed items also appear for review in `/billing/worklist`.

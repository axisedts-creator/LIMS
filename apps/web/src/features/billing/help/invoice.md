# Invoice

## Purpose
Review one invoice, print it, and correct it when needed. The page shows the invoice as issued, its payments and its history.

Invoices cannot be edited or deleted. To correct an invoice, cancel it with a reason; a credit note is issued automatically. For a smaller correction, use Partial credit to credit part of the amount instead of the whole invoice. Both actions add a credit note and keep the original invoice unchanged.

## Fields
- **Cancel invoice** – asks for a reason (choose a reason and add details if needed). The invoice is marked Cancelled and a credit note for the full amount is issued with the next credit note number.
- **Partial credit** – credits chosen lines or amounts. Enter the reason, then Issue credit note.
- **Request refund** – asks finance to return money already paid. Choose the payment method, the refund amount (up to the refundable balance) and a reason, then Send for approval. A second person with approval rights must approve it; you cannot approve your own request.
- **Print** – prints the invoice. The first print is the original; later prints are marked as copies and counted.
- **Invoice history** – every print, cancellation, credit note and refund, with who did it and when.
- **CBMS** – the IRD CBMS status of this document. Until the connection is set up it reads "Not sent — CBMS connection not configured".

## Shortcuts
- `?` – list all shortcuts on this screen.
- `Ctrl+Enter` – submit the open dialog (Issue credit note, Send for approval).
- `Esc` – close the open dialog without saving.

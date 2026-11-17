# CBMS

## Purpose
Track whether each invoice, credit note and cancellation has been sent to the IRD's Central Billing Monitoring System (CBMS). Today the lab's CBMS connection is not configured, so documents are recorded but not sent. The screen says so plainly so nobody assumes otherwise.

## Fields
- **Kind** – invoice, credit note or invoice cancellation.
- **Document no** – the number of the document.
- **Last attempt** – the time of the last send attempt, or a dash if none.
- **State** – one of:
  - **Not sent — CBMS connection not configured** – the document is recorded and waits for a connection.
  - Not required – your lab's settings say real-time CBMS is not needed.
  - Sent – the CBMS service accepted the document. This only appears once a live connection exists.
  - Failed – the CBMS service refused the document. Finance reviews it.
- **Attempts / Last outcome** – how many times a send was tried and the last result.
- **Retry** – shown on Failed documents to people who may retry.

This screen reports the lab's own sending status. It is not a statement by the IRD about the lab's invoices.

## Shortcuts
- `?` – list all shortcuts on this screen.

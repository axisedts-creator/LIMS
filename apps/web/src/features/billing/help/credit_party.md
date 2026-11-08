# Credit party

## Purpose
Manage one credit party: its terms, the charges posted to it, and its monthly statement. Use it to check the balance before accepting a credit order and to see what each month's closing balance is.

## Fields
- **Terms tab** – credit limit, credit days and lock state with the reason. Changes to the terms, made elsewhere, are recorded in the audit trail.
- **Charges tab** – each charge with Created time, Status, Amount and a link to the invoice it belongs to (Open invoice).
- **Statement tab** – one row per month:
  - **Month / Fiscal year** – the period (fiscal year in B.S.).
  - **Invoiced** – charges invoiced in the month.
  - **Paid** – payments received.
  - **Credited** – credit notes issued, including cancellations.
  - **Closing** – the balance at the end of the month.

A cancelled invoice is not removed from the statement. Its credit note appears under Credited, and the balance falls by that amount.

## Shortcuts
- `?` – list all shortcuts on this screen.
- `Left` / `Right` – move between the Terms, Charges and Statement tabs.
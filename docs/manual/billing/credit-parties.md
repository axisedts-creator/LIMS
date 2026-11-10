# Credit parties (screens `/billing/credit-parties` and `/billing/dues`)

Credit parties are organisations that buy on credit, such as hospitals, companies and referring clinics. This page mirrors the in-app help for Credit parties, Credit party and Dues.

## List (`/billing/credit-parties`)

Columns: Code, Name, Limit, Used, Credit days, Lock. A party is Locked, with a reason, when it must not receive new credit charges. If "Lock credit parties automatically after the credit days" is on in `/billing/settings`, a party is locked once its balance stays unpaid past its credit days.

## One party

Open a party from the list. Three tabs:

- **Terms** – credit limit, credit days, lock state. Changes are recorded in `/billing/audit-trail`.
- **Charges** – Created, Status, Amount, and a link to the invoice.
- **Statement** – by month: Invoiced, Paid, Credited, Closing balance, with the B.S. fiscal year.

## Dues (`/billing/dues`)

Lists registrations with a balance still to collect: Registration no, Patient, Centre, Invoiced, Paid, Credited, Due, Oldest invoice age. Due is invoiced minus paid minus credited.

## Corrections

Invoices cannot be edited or deleted. To correct a charge billed to a party, cancel the invoice with a reason, or issue a partial credit; a credit note is issued automatically and appears under Credited on the statement. Refunds go through approval in `/billing/worklist`; the person who requests a refund cannot approve it.

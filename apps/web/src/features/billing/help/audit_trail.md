# Audit trail

## Purpose
Read the record of billing actions: who issued, printed, cancelled, credited, refunded or exported what, and when. The trail is append-only. Entries cannot be edited or deleted by anyone, which is how the lab shows that invoices were never changed after issue.

## Fields
- **Time** – when the action happened, in B.S. and A.D.
- **User** – the staff member who did it.
- **Action** – what was done, for example invoice issued, invoice printed, invoice cancelled, credit note issued.
- **Document** – the type of document and the start of its identifier. Open the invoice from the invoices list to see it in full.
- **Details** – a short summary, or a dash when there is none. Personal data is not copied into the summary.
- **Export** – creates a file of the trail for the filters you chose, for people who hold the export permission. Each export is itself recorded here.

## Shortcuts
- `?` – list all shortcuts on this screen.

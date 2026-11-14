# Registers

## Purpose
View the sales register, the cancelled invoices register and the credit notes register for a fiscal year or date range, and export them as files. Use it when you need the records for your accountant or for a tax filing you prepare yourself.

## Fields
- **Sales register tab** – every invoice with serial number, B.S. and A.D. date, invoice no, buyer, buyer PAN, total, exempt, taxable, VAT, other tax and status.
- **Cancelled invoices tab** – cancelled invoices with the cancellation date, credit note no, buyer and reason code.
- **Credit notes tab** – credit notes with kind (cancellation or partial), the invoice they refer to, reason code and amounts.
- **Fiscal year (B.S.)** – for example 2083/84.
- **Date range** – limits the rows by date.
- **Export** – creates an XML or PDF file for the tab you are on. The XML uses the lab's own schema `urn:lims:billing:export:v1`. It is not an IRD schema, and the system does not submit it to the IRD. Files are kept for 24 hours; download yours promptly. See the manual page on exports for the layout.

## Shortcuts
- `?` – list all shortcuts on this screen.
- `Left` / `Right` – move between the register tabs.

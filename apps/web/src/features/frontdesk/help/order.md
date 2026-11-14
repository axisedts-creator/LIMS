# Order

## Purpose
See one order and act on it: review the items, check billing, manage attached request forms, change the items, or cancel the order. The screen is at `/frontdesk/orders/<id>`. Buttons you cannot use are hidden; the server still checks every action.

## Fields
- **Header** – registration number, status, patient, visit type, billing mode, referrer, registered time and any flags.
- **Items tab** – code, name, priority, status and price of each test. **Add tests** shows a quote first, then adds. **Remove** asks for a reason; if the item was already invoiced, Finance issues a credit note.
- **Billing tab** – invoiced, paid, credited and balance due, plus invoices, payments and open finance tasks. **Record payment** takes a method, an amount up to the balance due, and an optional reference.
- **Attachments tab** – test request forms. A file is shown as scan pending until the security scan finishes; only clean files can be previewed.
- **Cancel order** – choose a reason and, if you wish, add a note. A cancelled order cannot be reopened. If money was paid, Finance must issue a credit note and refund.
- **Booked orders** – a pre-registered order shows "Booked — confirm on arrival"; confirm it from the registration payment panel.

## Shortcuts
- `Ctrl+Enter` – confirm the open dialog (record payment).
- `Esc` – close the open dialog without saving.
- `?` – list the shortcuts available on this screen.

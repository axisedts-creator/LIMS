# New registration

## Purpose
Register a patient visit in one screen: pick or create the patient, set the visit, add tests, check the bill, take payment, then register and print. The screen is at `/frontdesk/registrations/new`. Your work is kept as a draft if you leave by mistake.

## Fields
- **Centre** – the centre you register at. If none is shown, ask your administrator to assign one.
- **Patient** – search by name, mobile or code, or open the new patient form.
- **Visit type** – OPD or IPD.
- **Billing mode** – cash or credit. Credit needs a **Credit party**.
- **Referrer** – the referring doctor. A missing doctor can be added on the spot.
- **Collection mode** – where the sample is taken.
- **Urgent order** – marks the whole order urgent. Single tests can also be marked urgent.
- **Downtime back-entry** – for paper forms written while the system was down. Fill in the **Original time** and the **Paper form serial**.
- **Tests** – search tests or packages; the selected tests list shows each item.
- **Bill** – the bill lines and any applied discounts. A discount that needs approval is sent to an approver.
- **Payment** – one row per payment method. If nothing is paid you are asked to confirm registering without payment.

## Shortcuts
- `F2` – focus patient search.
- `Alt+N` – new patient form.
- `F3` – focus referrer.
- `Alt+D` – quick-add doctor.
- `F4` – focus test search.
- `Del` – remove the focused item.
- `U` – toggle urgent on the focused item.
- `Alt+R` – urgent for the whole order.
- `Alt+O` – visit type OPD.
- `Alt+I` – visit type IPD.
- `Alt+C` – toggle cash / credit.
- `F6` – discount dialog.
- `Alt+A` – request discount approval.
- `F8` – focus payment amount.
- `Alt+P` – add a payment method row.
- `Alt+U` – TRF upload.
- `Ctrl+Enter` – register and print.
- `Ctrl+Shift+N` – new registration (after success, or to discard the current one).
- `Alt+L` – retry label print.
- `Alt+G` – open the order (after success).
- `Esc` – close a dialog or clear the search.
- `?` – show this list on screen.

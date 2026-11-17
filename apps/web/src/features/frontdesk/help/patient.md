# Patient

## Purpose
Review and maintain one patient: demographics, consent, past visits, and anonymisation. The screen is at `/frontdesk/patients/<id>`. The phone number is shown masked; the full number appears only inside the edit form.

## Fields
- **Demographics** – patient code, sex, age and masked phone. **Edit demographics** changes name, phone, email and address. If someone else saved first, reload and try again.
- **Consents** – data processing, SMS, WhatsApp, email and sharing with the referrer, each Yes or No, with the consent text version. **Update consent** records a new set of choices.
- **Visits** – registration number, date, source and status of each order; open one from its number.
- **Anonymise** – removes personal details. Orders and invoices are kept for the legal retention period. It needs MFA and is blocked while the patient has an open order. Anonymisation cannot be undone, and an anonymised patient can no longer be edited.

## Shortcuts
- `Ctrl+Enter` – save the consent dialog.
- `Esc` – close the dialog or form.
- `?` – list the shortcuts available on this screen.

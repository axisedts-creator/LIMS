# Discount approvals

## Purpose
Approve or reject discount requests raised at registration. The screen is at `/frontdesk/discount-approvals` and is for people with the approver role. The list refreshes about every 10 seconds.

## Fields
- **Requested** – when the request expires and the minutes left. An expired request can no longer be approved.
- **Centre / Requested by / Patient code** – where, who and for whom.
- **Gross / Discount** – the bill total and the discount in NPR and percent.
- **Reason** – the coded reason and any text.
- **Status** – pending, approved, rejected or expired.
- **Details** – every discount line of the request.
- **Approve** – confirms the discount. You cannot approve your own request; it needs another approver.
- **Reject** – a **Note** (up to 500 characters) is required.
- **MFA** – approving needs a second factor. If asked, open your profile, set up MFA and try again.

## Shortcuts
- `A` – approve the focused pending row (after a confirmation).
- `R` – reject the focused pending row (the note is required).
- `Ctrl+Enter` – submit the reject dialog.
- `Esc` – close the dialog.

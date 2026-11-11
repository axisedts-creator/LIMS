# Delivery log

## Purpose
See every message and print that was sent for reports, and what happened to each. Use it to answer "did the patient get it?" and to send a failed message again.

## Fields
- **Created**, **Channel** (WhatsApp, SMS, Email, Print, Portal), **Purpose**, **Recipient** (Patient, Referrer, Centre, Staff).
- **To**: the destination is always masked, for example the first and last digits only. The full number or address, the message text, any link, and any one-time code are never shown here.
- **Status**: Queued, Sent, Delivered, Read, Failed, or Suppressed (not sent because there is no consent, no contact, or the channel is off).
- **Attempts**: how many tries were made. **Report**: opens the report.
- **Resend**: shown on failed rows only, and only if you may resend. It queues a new attempt.
- Filters: status, channel, purpose, and date range. Filters stay in the page address so you can share the view.

## Shortcuts
This screen has no page shortcuts. Use Tab and Enter to move through filters, rows, and buttons.

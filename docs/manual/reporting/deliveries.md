# Delivery log

Address: `/reporting/deliveries`. This list has no permission of its own in the route table; each row opens the delivery page, which needs `reporting.delivery.read`.

## Purpose

See every message and print sent for reports, and what happened to each. Use it to answer "did the patient get it?" and to send a failed message again.

## Fields

- **Created**, **Channel** (WhatsApp, SMS, Email, Print, Portal), **Purpose**, **Recipient** (Patient, Referrer, Centre, Staff).
- **To**: the destination is always masked, for example only the first and last digits. The full number or address, the message text, any link, and any one-time code are never shown here.
- **Status**: Queued, Sent, Delivered, Read, Failed, or Suppressed.
- **Attempts**: how many tries were made.
- **Report**: opens the report.
- **Resend**: on failed rows only, and only if you may resend.

## Steps: find a message

1. Set the status filter, channel, purpose, and the date range. The range can be at most 31 days.
2. Open the row to see the detail page ([delivery.md](delivery.md)).
3. Filters are kept in the page address, so you can share the filtered view.

## Why a message was Suppressed

Suppressed means the system did not try to send. The usual reasons are in plain words: the patient has not agreed to this channel (no consent), there is no phone number or email on file, or the channel is switched off for your lab. Fix the cause and resend, or use another channel.

## Shortcuts

None for this screen. Use Tab and Enter.

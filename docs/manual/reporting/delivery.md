# Delivery

Address: `/reporting/deliveries/{delivery_id}`. Permission to open: `reporting.delivery.read`.

## Purpose

One delivery and its attempts in detail. The page explains in plain words why a message was not sent or failed, and lists each attempt in time order. The same content opens as a side panel from the [delivery log](deliveries.md).

## Fields

- **Channel**, **Purpose**, **Recipient**, **To**: the destination is masked.
- **Never shown**: the message text, links, one-time codes, and the full number are never shown on this page, even to administrators.
- **Reason**: the explanation for a message that was not sent or failed.
- **Attempts**: each attempt with its time and outcome.
- **Resend**: for a failed delivery, if you may resend.
- **Back to delivery log**: returns to the list with your filters.

## What the reasons mean

| Reason shown | What to do |
|---|---|
| Not sent: the patient has not agreed to this channel | Ask the patient for consent at the counter, or use another channel. |
| Not sent: no phone number or email on file | Update the patient contact details, then resend. |
| Not sent: this channel is switched off for your lab | Ask an administrator to check the settings. |
| The messaging provider rejected the message | Check the channel account on the Messages screen. |
| The number or address was not accepted | Correct the contact details, then resend. |
| The WhatsApp template is not approved yet | Wait for approval, or use SMS. |
| Sending failed after several tries | Resend once. If it fails again, see [runbooks.md](runbooks.md). |
| The provider is not responding; we will try again | Wait. The system retries and may fall back to SMS. |
| Replaced by a newer attempt | Nothing; look at the newest attempt. |

## Steps: resend

1. Open the failed delivery.
2. Press Resend and confirm. A new attempt starts; the old attempts are not changed.

## Shortcuts

None for this screen. Use Tab and Enter; Esc closes a dialog.

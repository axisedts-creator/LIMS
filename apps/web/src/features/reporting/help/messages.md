# Messages and channels

## Purpose
Set the wording of the messages patients and doctors receive, and connect the sending accounts for WhatsApp, SMS, and email. Message templates only accept the placeholders they declare.

## Fields
- **Template**, **Purpose**, **Channels**, **Status**: Active or Draft per channel. WhatsApp texts also show their approval: Draft, Submitted, Approved, or Rejected. A WhatsApp text is used only after it is approved.
- **Edit**: choose the channel and language, then write the body (up to 1000 characters; a counter is shown). Email also has a subject (up to 150 characters). Use Insert to add a declared placeholder.
- **Provider**: which service sends the channel. Recording is for testing only and is not offered in production.
- **Secret reference**: the name of a secret your operator stored. The secret itself is never entered here.
- **Generate callback URL**: shows the URL once. Copy it into the provider's settings; it cannot be shown again.

## Shortcuts
This screen has no page shortcuts. Use Tab and Enter; Esc closes a dialog.

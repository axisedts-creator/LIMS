# Messages and channels

Address: `/reporting/messages`. Permission: `reporting.message_template.manage`.

## Purpose

Set the wording of the messages patients and doctors receive, and connect the sending accounts for WhatsApp, SMS, and email. A message template only accepts the placeholders it declares.

## Fields

- **Template**, **Purpose**, **Channels**, **Status**: Active or Draft for each channel.
- **WhatsApp approval**: Draft, Submitted, Approved, or Rejected. A WhatsApp text is used only after it is approved. Approval is done in your WhatsApp Business account; record the result here.
- **Edit**: choose the channel and language (English or Nepali), then write the body (up to 1000 characters; a counter is shown). Email also has a subject (up to 150 characters). Use Insert to add a declared placeholder such as the lab name.
- **Provider**: which service sends the channel. Recording is for testing only and is not offered in production.
- **Sender id**: the name or number messages are sent from (up to 64 characters).
- **Secret reference**: the name of a secret your operator stored. The secret itself is never entered here.
- **Active**: switches the channel account on or off.
- **Generate callback URL**: see below.

## Steps: change a message

1. Open the template and choose the channel and language.
2. Edit the body. Insert placeholders with the Insert button rather than typing braces.
3. Save. For WhatsApp, submit the wording for approval in your WhatsApp Business account, then record Approved or Rejected here.

## Steps: connect a provider

1. In the channel account card choose the provider and fill in the sender id.
2. Type the secret reference, which is a name only. Ask your operator to store the secret under that name.
3. Press Generate callback URL. The URL opens in a copy dialog and will not be shown again. Copy it into the provider's settings before you close the dialog.
4. Switch the account to Active.

If you lose the URL, generate a new one; see the rotate section of [runbooks.md](runbooks.md).

## Shortcuts

None for this screen. Use Tab and Enter; Esc closes a dialog.

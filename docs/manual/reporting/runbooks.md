# Reporting runbooks

For operators and lab administrators. Each section gives the sign, the likely cause, and the action. Examples are synthetic.

## Searching logs

Search by `report_id`, `delivery_id`, or `request_id`. Never search by phone number or name: they are not logged, so a search would find nothing and would tempt people to paste personal data into tools.

Renderer health: `GET /internal/health` returns `status`, `browser_pid`, `contexts_busy`, and `renders_since_recycle`. A `contexts_busy` that stays at its maximum for many minutes points to a stuck renderer.

## Renderer stuck or out of memory

Sign: reports stay in Render failed or Awaiting content, and the health endpoint is slow or does not answer.

Cause: the browser process in the renderer container hung or ran out of memory.

Action: restart the renderer container. Versions that were being rendered resume by themselves through the sweep job; nobody needs to press Regenerate. If the same report fails again after a restart, regenerate it once from the report page with a reason.

## Sandbox rejections spike

Sign: many uploaded images or outsourced PDFs show Rejected or Blocked.

Cause: a bad file batch from one external lab, a change in the sandbox rules, or a scanner problem.

Action: check the test corpus results first (the known-good files should pass), then the scanner state. If the corpus passes and one lab sends bad files, ask that lab for new copies. If the corpus fails, stop and report it to the engineering team; do not turn the sandbox off.

## Provider outage

Sign: many deliveries show "The provider is not responding; we will try again", and the circuit is open.

Cause: the messaging provider is down or slow. After repeated failures the system opens the circuit and stops calling it for a while.

Action: WhatsApp deliveries fall back to SMS after the delay in the settings ([settings.md](settings.md)). Nothing is lost. After the provider recovers, find the failed deliveries in the [delivery log](deliveries.md) and use Resend for each. Do not resend while the circuit is still open.

## WhatsApp template rejected

Sign: a WhatsApp message template shows Rejected after submission, or deliveries show "The WhatsApp template is not approved yet".

Cause: Meta rejected the wording, or the template was never approved.

Action: on the settings screen put SMS first in the patient mobile channel order so patients still get reports. Edit the wording on the [Messages screen](messages.md), submit it again in your WhatsApp Business account, record the result, and put WhatsApp first again once it is Approved.

## Rotate a callback token

When: the callback URL was shown to the wrong person, or the provider account changed.

Action: open the [Messages screen](messages.md) and generate a new callback URL for the channel. It is shown once. Copy it into the provider's settings straight away; the old URL stops working. The server keeps only a hash of the token, so a lost URL cannot be looked up again, only replaced. Rotation needs `reporting.channel.manage`.

## Revoke links after a mis-send

When: a batch of report links went to the wrong people.

Action: find the deliveries of the batch in the [delivery log](deliveries.md) by date range and channel, open each report, and revoke its link or QR code. There is no bulk revoke yet, so each report is done one at a time; a bulk revoke is a foreseen change request. Tell the patients affected through your normal incident process.

## Restore a missing PDF

Sign: a released version shows a Download link that fails, or the file is missing from storage.

Cause: storage loss or a damaged file.

Action: released versions are immutable. Re-render is not allowed for a released version, because a new render could differ from what the patient already holds. Restore the original file from the storage backup. Open the version afterwards and check that it downloads and that the page count matches. If no backup has the file, escalate to the engineering team.

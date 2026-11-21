# Receiving manifests and pickups (lab staff)

This page is for lab staff. Examples use synthetic data only.

## Manifest inbox

Open `/partners/manifests`. You need the permission `partners.manifest.receive`. The inbox lists manifests that partners submitted. Filter by partner, by status or by missing samples. Open a manifest at `/partners/manifests/{manifest_id}` to receive it.

1. Compare the box with the lines of the manifest.
2. Mark each line received, or record why a sample is missing or not acceptable.
3. Lines that are received are converted into lab orders. If a conversion fails, the line shows an error and you can retry; the retry does not create a duplicate order.

## Consent and attestation

The partner attests patient consent for every line, and the lab keeps the text version that was confirmed. The lab cannot verify this attestation. Treat it as a declared statement, not as proof, and escalate to your supervisor if a line looks doubtful. Whether partner attestation is enough under your local rules is a decision for the lab, so confirm it with your compliance owner before relying on it.

## Pickup queue

Open `/partners/pickups`. You need `partners.pickup.manage`. The queue lists pickup requests with date, window and status. Schedule a request, mark it collected or decline it with a reason; the partner sees each change on their own Pickups page.

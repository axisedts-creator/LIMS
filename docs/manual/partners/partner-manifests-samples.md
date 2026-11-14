# Manifests, samples and pickups (partner users)

This page is for people at a partner organisation. All names and numbers shown in examples are synthetic data.

## Manifests

Open `/manifests` to see the manifests of your organisation. A manifest is one batch of patient samples sent to the lab. You need the permission `partners.manifest.submit` to create and submit manifests; users without it can only look.

1. Start a new manifest and add one line per patient: the patient details, your own sample reference and the tests or panels.
2. For every line, confirm patient consent using the statement shown on the page. This is your attestation that the patient agreed. The lab stores which version of the statement you confirmed.
3. Submit the manifest. It is now locked and the lab can see it.

Open a single manifest at `/manifests/{manifest_id}`. You can print it for the courier, or withdraw it while the lab has not yet received it.

## Samples

Open `/orders` for the samples the lab registered from your manifests. You need `partners.order.read`. Each row shows a tracking status as a chip with an icon and a word. Open a row to see details and the report once it is released.

## Pickups

Open `/pickups` to see your collection requests and their statuses. To ask for a new collection open `/pickups/new`; this needs `partners.pickup.request`. Choose a date within the number of days ahead that the lab allows, a time window, and add a note for the courier.

## Tips

- Keep printed manifests with the samples and out of shared areas.
- Never put real patient data in training material; use invented names.

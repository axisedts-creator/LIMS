# Partner administration (lab staff)

This page is for lab administrators. Examples use synthetic data only.

## Partner records

Open `/partners` to see all partner organisations. You need the permission `partners.partner.read` to look and `partners.partner.manage` to add or change a partner. Open one partner at `/partners/{partner_id}` to edit its profile, its users and its price list. Each section has its own Save button. Deactivating a partner or a partner user stops their sign-in; manifests and reports stay in the system.

## Doctor mapping

Open `/partners/referrers`. You need `partners.referrer.map`. Partners add their own referring doctors; map each one to a doctor record of your lab so orders and reports reach the right person. If the lab requires a mapped doctor, lines with an unmapped doctor cannot be converted to orders.

## Settings and consent statement

Open `/partners/settings` (needs `partners.partner.manage`) to set the limits: lines per manifest, how long drafts are kept, how far ahead pickups may be booked and the daily report download limit per user.

The same page holds the consent statement that partner users confirm for each patient, and its version. Change the version whenever you change the wording, so older lines keep the statement they were attested against. Remember that attestation is a declaration by the partner and the lab cannot verify consent itself.

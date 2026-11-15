# Home collection: admin settings

This guide is for the administrator who sets the rules for home collection (`/homecollection/settings`) and manages phones (`/homecollection/devices`). Change what you need and press **Save settings**, or press **Ctrl+Enter** from any field. Every value is checked before it is sent. If someone else saved first, a banner asks you to reload and try again.

## Sync and privacy

- **Sync interval** is how often a phone asks for changes, in seconds.
- **Clear phone data after offline** is how many hours a phone may stay offline before it erases its data.
- **GPS kept for** is how many days a captured location point is kept. Capturing GPS is off until the location component is available.
- **Allow maps hand-off** lets the phone open its own maps app with the **Navigate** button. Only the visit address is sent, never a name, tests or phone number.
- **Minimum app version** is written like 1.10.0. Phones below it show **Update required** on the devices page.

## Visit checks

- **Second identifier** is the second thing a phlebotomist checks with the patient.
- **Allow typed barcodes** lets staff type a tube barcode when the scanner fails.
- **Consent text** is what the phlebotomist reads out. Change the **Consent text version** whenever you change the text.

## Payments, handover and routes

Choose between 1 and 10 payment methods, each at most once, with a label and whether a reference is needed. **Confirmation at centre required** makes tubes wait for a check at the centre, and **Overdue after** is how many hours before an unconfirmed handover is flagged. **Max visits per route** limits one phlebotomist's day.

## Devices and remote wipe

The devices page lists every registered phone, its app version and its last sync. For a lost or stolen device:

1. Find the phone and choose **Revoke** so it can no longer sync.
2. Choose **Wipe**. The phone erases its data at its next contact with the server, or after the offline limit above.
3. Tell the dispatcher which visits were on that phone so unsynced work can be recovered.

A wiped phone must be registered again before it is used.

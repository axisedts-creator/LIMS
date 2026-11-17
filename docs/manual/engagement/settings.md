# Engagement settings

This page explains the settings screen. It mirrors the in-app help for `engagement.settings`. Screen: `/engagement/settings`. Needs `engagement.settings.manage`. Saving needs a second sign-in step (aal2, also called MFA); the shell asks for it when it is missing.

## Sections

- Features: app, bookings, home collection, queue, reminders, memberships, enquiries, smart summary in the app, partner orders.
- Patient app: allowed phone prefixes, daily code limit, minimum app versions, payment gateways, support phone, consent text and its version, limits on profiles and accounts, link code lifetime, dormancy days, minor age.
- Bookings: how far ahead patients can book, lead time, cancel cut-off, no-show grace, limits, reminder hours, home collection centre.
- Reminders: automatic follow-up switch and lead days.
- Queue: how many past tokens a display keeps.

Each section has its own Save. Confirm the legal age with your counsel before you change the minor age.

## Consent text

Patients accept the consent text before they receive a code. If you change the consent text you must also set a new version label. The version is stored with each consent, so older consents keep their own text.

## Legal links

Both apps show Privacy policy and Terms of use on first run and on the About screen, and open them in the system browser. The addresses are not set on this screen. They come from platform config: `legal.privacy_url` and `legal.terms_url`, both required in production builds. A lab may also add an optional tenant privacy URL, which the apps show under the lab name. The same addresses are written in the release checklist for the store listings (LD-28).

## Who can issue codes

Issuing app codes is a separate permission, `engagement.link.issue`. Giving it to a role is done in the access settings, not here.

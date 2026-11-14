# Doctors, users and account (partner users)

This page is for administrators and staff at a partner organisation. Examples use synthetic data only.

## Referring doctors

Open `/referrers` to see the doctors who refer patients through your organisation. You choose one of them on each manifest line. Users who may manage doctors also see Add doctor. The lab maps each doctor to its own record; until that is done, the lab may be unable to convert some lines into orders.

## Users

Open `/users` to manage your team. This needs the permission `partners.partner_user.manage`. Press Invite user, enter a work e-mail address such as someone@example.com and choose a role. The person sets up their own sign-in from the invitation. Deactivate a user as soon as they leave your organisation.

Roles decide what a person can do:

- `partners.manifest.submit` lets them create and submit manifests.
- `partners.pickup.request` lets them request pickups.
- `partners.order.read`, `partners.report.read` and `partners.statement.read` let them view samples, reports and statements.

## Account

Open `/account` to see your own details and the organisation you belong to. Contact your administrator to change your role. Never share your sign-in and sign out on shared computers.

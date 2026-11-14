# Active sessions

## Purpose

Active sessions lists every browser where a member of your lab is logged in right now, including sessions opened by LIMS provider support staff. Use it to end a session on a lost or shared device. Address: `/admin/sessions`. Permission: `identity.session.revoke`.

## Columns

- **User**, **Started**, **Last active**, **Expires**.
- **IP**: the address with the last part masked, for example `203.0.113.x`.
- **Browser**.
- **Two-step**: "Verified" when the user completed two-step verification in this session.
- **Support**: a badge on sessions of LIMS provider support staff.

## Filters

- **User**: search by name or email.
- **Support only**: show only support sessions.

## Steps

### Log out a session

1. Find the session with the User filter.
2. Select **Log out** on the row and confirm.
3. The user is logged out at once and must log in again.

To log out every session of one user, use **Log out all sessions** on their [user detail](user-detail.md) page.

### Check support access

Turn on **Support only** to see whether LIMS provider support staff are working in your lab now. See [Support access](support-access.md) to end their access.

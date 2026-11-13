# Access log and sign-in events

## Purpose

This screen shows who looked at sensitive records and who signed in or failed to sign in. Use it to check access to a patient's records or to investigate failed logins. Address: `/admin/access-log`. Permission: `audit.log.read`.

## Tabs

- **Access log**: columns Time, User, Event, Entity type, Entity id, Centre. The entity is the record that was viewed, for example a report.
- **Sign-in events**: columns Time, User, Event, Reason, IP, Browser. Events include successful logins, failed logins, two-step verification and logouts.

## Filters

Date range (at most 31 days), User and Event, as on the [audit log](audit.md).

## Steps

### Check who viewed a record

1. Open the **Access log** tab.
2. Set the date range and filter by entity id.
3. Each row is one view by one user.

### Investigate failed logins

1. Open the **Sign-in events** tab.
2. Filter by the user and look at the reason and IP of the failures.
3. If you suspect someone else is trying the account, lock the user on their [user detail](user-detail.md) page and ask them to reset their password.

To keep a copy, use [Exports](exports.md).

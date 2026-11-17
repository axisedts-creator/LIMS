# Users

## Purpose

Users lists everyone who belongs to your lab: invited, active and deactivated staff. Use it to find a person, check their roles and centre access, and invite someone new. Address: `/admin/users`. Permission: `identity.user.read`; inviting needs `identity.user.manage`.

## Filters

- **Status**: All, Invited, Active, Deactivated. The default shows Active and Invited.
- **Locked**: Any, Locked, Not locked. A lock is separate from status, so an active user can be locked.
- **Role**: users holding the chosen role.
- **Centre**: users who can work at the chosen collection centre.
- **MFA**: Any, On, Off (two-step verification).
- **Search**: name or email, 2 to 100 characters.

## Columns

Name, Email (masked, for example `te***@example.test`), Status with a Locked badge, Roles (up to three, then "+n"), Centres ("All centres" or a count), MFA (On or Off), Last login.

## Steps

### Find a user

1. Press `/` to jump to the first filter, or type in the search box.
2. Combine filters as needed. If nothing matches, select **Clear filters**.
3. Select a row (or press Enter on it) to open the user detail.

### Invite a user

Select **Invite user** (or press `n`). See [Invite user](user-new.md).

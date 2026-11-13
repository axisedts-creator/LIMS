# Platform staff

## Purpose

Platform staff lists the LIMS provider staff who can use the platform console, with the networks they may sign in from. Address: `/platform/staff`. Permission: `platform.staff.manage`.

## Columns

Name, Email, Role, Allowed networks, MFA, Status.

## Fields

The invite dialog has email (for example `support.one@example.test`), name, role, and allowed networks. Each allowed network is a CIDR range such as `198.51.100.0/24` or an IPv6 CIDR; sign-in from any other network is refused.

## Steps

### Invite a staff member

1. Select **Invite** (or press `n`).
2. Enter email, name and role.
3. Add each office or VPN network as a CIDR chip.
4. Submit. The staff member receives an invitation and must set up two-step verification.

### Log out a staff member

Open the **Sessions** tab and select **Log out** on the session, for example when a laptop is lost.

Review the list regularly and deactivate staff who no longer need access.

# Sign-in events

## Purpose

Sign-in events lists logins, failed logins and logouts across all tenants and the platform console. Use it to investigate attacks on many accounts or a single user's sign-in problem. Address: `/platform/auth-events`. Permission: `platform.tenant.read`.

## Filters

- **Date range**: at most 31 days.
- **Tenant**: a lab, or "No tenant" for platform staff and attempts that matched no lab.
- **Event**.

## Columns

Time, Tenant, User, Event, Reason, IP, Browser.

## Steps

### Investigate failed logins

1. Set the date range around the problem.
2. Filter Event to failed logins and look for many failures from one IP or against many users.
3. Tell the affected lab's administrator; they can lock users from their own admin screens.

### Check platform staff sign-ins

Choose "No tenant" to see platform console sign-ins, including those refused because the network was not allowed.

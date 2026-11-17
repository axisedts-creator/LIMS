# Tenant detail

## Purpose

Tenant detail shows one lab and lets LIMS provider staff change its status, settings and features, track its IRD annexes and manage its administrators. Address: `/platform/tenants/{tenant_id}`. Permission: `platform.tenant.read`; changes need `platform.tenant.manage`.

## Tabs

- **Overview**: status timeline and the actions Activate, Suspend, Reactivate and Terminate.
- **Settings**: the full lab settings, including fields only the platform may change, such as legal name and PAN.
- **Feature flags**: a switch per feature. Flags marked "Founder approval" need an approval reference (up to 200 characters) before they can be turned on.
- **IRD annexes**: the IRD annex records of this tenant, as in the [IRD annex tracker](ird.md).
- **Administrators**: invite an additional tenant administrator.
- **Support sessions**: support sessions opened for this tenant.

## Steps

### Change the tenant status

1. On **Overview**, select the action: Activate, Suspend, Reactivate or Terminate.
2. Enter a reason. A reason is required for suspend and terminate.
3. To terminate, also type the tenant code to confirm. Termination cannot be undone.

Suspending a tenant logs out its users; they see that access for their lab is suspended.

### Turn on a feature

Open **Feature flags**, turn the switch on and, for founder-approval flags, enter the approval reference. Save.

If someone else changed the tenant meanwhile, you see "This record was changed by someone else"; select Reload.

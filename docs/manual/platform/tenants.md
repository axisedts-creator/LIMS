# Tenants

## Purpose

Tenants lists every lab that uses the LIMS, with its status and readiness. Address: `/platform/tenants`. Permission: `platform.tenant.read`; provisioning needs `platform.tenant.manage`.

## Columns

- **Code**: the tenant code, for example `demo_lab`.
- **Display name**.
- **Status**: for example active or suspended.
- **Users** and **Centres**: counts.
- **IRD readiness**: Complete when every IRD annex record of the tenant is complete, otherwise Incomplete.
- **Created**.

## Steps

### Find a tenant

Type part of the code or name in the search box, or sort by a column. Select a row to open the [tenant detail](tenant-detail.md).

### Provision a new tenant

Select **Provision tenant** (or press `n`). See [Provision tenant](tenant-new.md).

### Follow up IRD readiness

Tenants marked Incomplete need attention in the [IRD annex tracker](ird.md).

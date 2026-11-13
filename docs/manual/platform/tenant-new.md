# Provision tenant

## Purpose

Provision tenant creates a new lab in one step: the tenant, its first branch, its first collection centre and its first administrator, who receives an invitation email. Address: `/platform/tenants/new`. Permission: `platform.tenant.manage`.

## Sections

- **Tenant**: tenant code (lower-case letters, digits and underscores, starting with a letter, 3 to 32 characters, for example `demo_lab`), legal name (up to 200 characters), display name (up to 120 characters), PAN (optional), timezone (shown as Asia/Kathmandu, read-only) and calendar display.
- **First branch**: code, name, address.
- **First centre**: code, name, type, address.
- **First administrator**: email (for example `admin@example.test`) and full name.

## Steps

1. Fill in the four sections: tenant, first branch, first centre and first administrator. Check the tenant code carefully; it cannot be changed later.
2. Select **Provision tenant**.
3. The result page shows a checklist of every item that was created and "Invitation sent" for the first administrator.
4. Ask the administrator to open the invitation and set a password. They then add users, roles and centres in the admin screens.

If a step fails, the result page shows which items were not created. Fix the cause and open the tenant detail to finish.

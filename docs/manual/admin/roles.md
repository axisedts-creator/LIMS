# Roles

## Purpose

Roles lists the sets of permissions you give to staff. Each user holds one or more roles. Address: `/admin/roles`. Permission: `identity.user.read`; creating and editing roles needs `identity.role.manage`.

## Columns

- **Name** and **Code**.
- **Default**: a badge on roles that come with the LIMS. Default roles cannot be deactivated.
- **MFA required**: Yes or No. Roles that hold privileged permissions show an MFA badge; their members must use two-step verification.
- **Members**: how many users hold the role.
- **Status**: Active or Deactivated.

## Steps

### Create a role

1. Select **New role** (or press `n`).
2. Fill in the role editor and save. See [Role editor](role-editor.md).

### Review who has a role

Note the Members count, then open [Users](users.md) and filter by the role.

### Change a role

Select the row to open the role editor. Changing a role logs out everyone who has it, so do it at a quiet time.

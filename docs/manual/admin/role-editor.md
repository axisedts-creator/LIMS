# Role editor

## Purpose

The role editor creates a role or changes its name, description and permissions. Address: `/admin/roles/{role_id}` (and `/admin/roles/new` for a new role). Permission: `identity.role.manage`.

## Fields

- **Name** (required, up to 80 characters).
- **Code** (required on create): lower-case letters, digits and underscores, starting with a letter, for example `front_desk_lead`. It cannot be changed after the role is created.
- **Description** (optional, up to 500 characters).
- **MFA required**: a switch. When you select any privileged permission it is forced on and cannot be turned off; the hint says "Includes privileged permissions" and the role shows the MFA badge in the roles list.
- **Permissions**: the permission matrix. Each row is an area of the LIMS; tick the permissions the role needs.

When the selected permissions let members receive or work on samples, a warning reminds you that members who process samples from other collection centres need All centres or every centre whose samples they process. It does not block saving.

## Steps

### Create or change a role

1. Enter the name and, for a new role, the code.
2. Tick the permissions in the matrix. Give only what the job needs.
3. Select **Save**. Changing a role logs out everyone who has it, so the new permissions apply at once.

### Deactivate a role

Select **Deactivate role**. The button is disabled for default roles and for roles that still have members; first move those users to another role.

If another administrator saved the role meanwhile, you see "This record was changed by someone else"; select Reload.

# Branches

## Purpose

Branches are the labs and offices of your organisation. A processing lab receives and tests samples; collection centres belong to a branch. Address: `/admin/branches`. Permission: `identity.user.read`; adding and editing branches needs `identity.centre.manage`.

## Columns

Code, Name, Phone, Status.

## Fields

The branch opens in a right drawer. Each section of the drawer has its own **Save** button.

- **Code** (required): letters, digits and hyphens, up to 16 characters. It is printed on reports and cannot be changed after the branch is created.
- **Name** (required, up to 120 characters).
- **Address** (up to 300 characters) and **Phone** (up to 30 characters).
- **Processing lab**: on (default) when this branch receives and tests samples.

## Steps

### Add a branch

1. Select **New** (or press `n`).
2. Enter the code, name and contact details in the drawer.
3. Turn **Processing lab** off for an office that does not test samples.
4. Select **Save**.

### Edit or deactivate a branch

Select the row; the drawer opens. Change the section and select its **Save**. Deactivated branches stay in history and are never deleted.

If another administrator saved the branch meanwhile, you see "This record was changed by someone else"; select Reload.

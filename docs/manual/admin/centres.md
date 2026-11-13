# Collection centres

## Purpose

Collection centres are the places where samples are collected: your own centres, franchise centres and home collection. Every centre belongs to a branch, and staff centre access is given per centre. Address: `/admin/centres`. Permission: `identity.centre.read`; adding and editing centres needs `identity.centre.manage`.

## Columns

Code, Name, Branch, Type, Phone, Status.

## Fields

The centre opens in a right drawer. Each section of the drawer has its own **Save** button.

- **Code** (required): letters, digits and hyphens, up to 16 characters, for example `C000000002`. It is printed on reports and cannot be changed after the centre is created.
- **Name** (required, up to 120 characters).
- **Branch** (required): the branch the centre belongs to.
- **Type**: Own (default), Franchise or Home collection.
- **Address** (up to 300 characters) and **Phone** (up to 30 characters).

## Steps

### Add a centre

1. Select **New** (or press `n`). With no centres yet, the screen invites you to add your first one.
2. Enter the code and name, choose the branch and the type.
3. Select **Save**.

Home collection can be added as its own centre, so home-collected samples are counted separately.

### Edit or deactivate a centre

Select the row; the drawer opens. Change the section and select its **Save**. Deactivated centres stay in history.

After adding a centre, give staff access to it on their [user detail](user-detail.md) page unless they already have All centres.

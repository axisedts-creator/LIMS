# Invite user

## Purpose

Invite user sends a new staff member an email link to set their password and join your lab with the roles and centre access you choose. Address: `/admin/users/new`. Permission: `identity.user.manage`.

## Fields

- **Email** (required): the address the invitation goes to, for example `new.staff@example.test`.
- **Full name** (required, up to 120 characters).
- **Mobile** (optional): international format starting with `+977` or another country code.
- **Roles** (required, 1 to 20): active roles. Roles with privileged permissions show an "MFA required" tag; the user must set up two-step verification before they can work.
- **Centre access**: All centres or Selected centres (default Selected centres).
- **Centres**: at least one when Selected centres is chosen; grouped by branch.
- **Branches** (optional).

When the roles receive or work on samples and Selected centres is chosen, a warning explains that staff who process samples from other collection centres need All centres or every centre whose samples they process. The warning does not block saving.

## Steps

1. Fill in email, full name and roles.
2. Choose centre access and, for Selected centres, pick the centres.
3. Select **Send invitation** (or press Ctrl+Enter).
4. The user receives an email link valid for a limited time. Until they accept, their status is Invited; you can resend the invitation from the user detail.

If the email cannot be invited, use a different email or contact LIMS provider support.

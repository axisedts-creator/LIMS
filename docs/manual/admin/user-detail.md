# User detail

## Purpose

User detail shows one staff member and lets you change their profile, roles, centre access, signatory details and sessions, and lock or deactivate them. Address: `/admin/users/{membership_id}`. Permission: `identity.user.read`; changes need `identity.user.manage`, and logging out sessions needs `identity.session.revoke`.

## Tabs

- **Profile**: full name, mobile, email (read-only).
- **Roles**: the user's roles and a Save button. Saving logs this user out of all sessions so the new roles apply at once.
- **Centre access**: All centres or Selected centres, with the same sample-processing warning as on Invite user. Saving also logs the user out.
- **Signatory**: shown for users who approve results. Title (for example MD Pathology), registration number and a signature image (PNG or JPEG, up to 1 MB). The signature is printed on reports this user approves.
- **Sessions**: the user's active sessions, each with **Log out**.
- **History**: the last 50 audit entries for this user, with a link to the full audit log.

## Steps

### Lock or unlock

1. Open the actions menu and select **Lock**.
2. Choose a reason (Left organisation, Security concern, Policy violation, Other) and add details; details are required for Other.
3. Confirm. Locked users are logged out immediately and cannot log in until unlocked. Select **Unlock** to reverse.

### Deactivate or reactivate

Select **Deactivate**, give a reason and confirm. The user keeps their history but can no longer log in. **Reactivate** restores access.

### Other actions

- **Resend invitation**: for users still Invited.
- **Reset two-step verification**: when the user lost their phone. They set it up again at next login.
- **Log out all sessions**: ends every session of this user now.

If another administrator saved the same user meanwhile, you see "This record was changed by someone else"; select Reload and repeat your change.

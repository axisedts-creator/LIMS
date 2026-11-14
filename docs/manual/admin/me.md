# My account

## Purpose

My account shows your own profile and lets you change your password, manage two-step verification and log out your other sessions. Address: `/admin/me`. Permission: `identity.self.manage` (every staff member has it).

## Tabs

- **Profile** (read-only): name, email, roles, centre scope and last login. Ask an administrator to change your roles or centres.
- **Security**: the Change password form and the Two-step verification card with its status (On or Off), a **Set up** button and the list of your authenticator devices with **Remove**.
- **Sessions**: every browser where you are logged in, with device and browser, IP address (masked), started, last active, expires, and a Current badge on this browser.

## Steps

### Change password

1. Open the **Security** tab.
2. Enter your current password, then the new password twice. It needs at least 12 characters and must not be a commonly leaked password.
3. Select **Save**. Your other sessions are logged out; this one stays logged in.

### Turn on two-step verification

1. On the **Security** tab, select **Set up** on the Two-step verification card.
2. Follow the three steps described in [Signing in](sign-in.md).

You cannot remove your last authenticator device when your role requires two-step verification.

### Log out another browser

On the **Sessions** tab, select **Log out this session** on the row you no longer use, for example a shared computer. The current session has no such button; use the main Log out menu instead.

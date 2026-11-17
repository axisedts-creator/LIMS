# Signing in

## Purpose

These screens let you log in to the LIMS, prove your identity with two-step verification, and recover a forgotten password. They appear before you are inside your lab, so they show the LIMS wordmark and no lab branding. The address is `/auth/login`. There is no Help panel on these screens; use the help link in the footer.

## Fields

- **Email**: the address your administrator invited, for example `asha.rai@example.test`.
- **Password**: your password. A new password needs at least 12 characters and must not be a commonly leaked password.
- **Code**: the 6-digit code shown in your authenticator app.

## Steps

### Log in

1. Enter your email and password and select **Log in** (or press Enter).
2. If your role needs two-step verification, enter the 6-digit code from your authenticator app and select **Verify**. Use the newest code; if codes keep failing, check that your phone's time is correct. After 5 incorrect codes you must log in again.
3. If the message says "Email or password is incorrect", check both and try again. After too many failed attempts, reset your password with **Forgot password?** or ask your lab administrator to unlock your account.
4. If your account is locked, not active, or your lab's access is suspended, contact your lab administrator.

### Set up two-step verification

1. Install an authenticator app on your phone (any TOTP app) and select **Continue**.
2. Scan the QR code, or select "Can't scan? Enter this key" and type the key. Give the device a name if you like.
3. Enter the 6-digit code and select **Confirm**. The screen shows "Two-step verification is on."

If your role requires two-step verification, you see this flow straight after logging in and cannot continue until it is done.

### Forgot password

1. Select **Forgot password?**, enter your email and select **Send reset link**.
2. The screen always says a link was sent if the account exists, so it never reveals who has an account. The link works once and expires in 60 minutes.
3. Open the link, enter a new password of at least 12 characters twice, and save. A password found in known data breaches is refused.

An invitation link opens the same page with the title "Welcome to" followed by your lab's name.

### Logged out or session expired

You are logged out after a period without activity or when your session ends. The screen explains why, for example when an administrator changed your access or your account was locked. Select **Log in again**.

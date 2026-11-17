# Front desk settings

## Purpose
Set the front desk rules for the whole lab: how large a discount staff may give without approval, and a few registration options. The screen is at `/frontdesk/settings` and is for people with the front desk settings permission (the administrator has it). Saving may ask you to confirm with two-step verification.

## Fields
- **Discount self-limit (%)** – a discount up to this percent needs no approval. Decimals are allowed (12.5). 0 means every discount needs approval.
- **Discount self-limit (NPR)** – the same limit in rupees. 0 means the percent limit alone decides.
- **Absolute max %** – no discount above this percent can be requested at all. The self-limit cannot be higher than this.
- **Require referrer** – registration needs a referrer.
- **Consent text version** – the version of the consent text patients agree to (1 to 32 characters).
- **Registration SMS** – send the registration SMS to the patient.
- **Label auto-print** – print specimen labels automatically.
- **Buyer PAN pattern** – a pattern (regular expression, up to 200 characters) the buyer PAN must match, for example `^[0-9]{9}$`.
- **Search min chars** – how many characters are needed before patient search starts. The server accepts only a narrow range; if it refuses your value the field shows the problem.
- **Save** – stores all fields at once. If someone else saved first you see "This record was changed by someone else"; choose **Reload** to see their values, then make your change again.

## Shortcuts
- `Tab` / `Shift+Tab` – move between fields.
- `Space` – turn a check box on or off.
- `Ctrl+Enter` – save.

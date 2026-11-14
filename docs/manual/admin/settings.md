# Lab settings

## Purpose

Lab settings hold the choices that apply to your whole lab: name and contact details, dates, sign-in rules, numbering, letterhead, report delivery, retention, features, billing and lab operations. Address: `/admin/settings`. Permission: `identity.settings.manage`.

## Tabs

The tabs are General, Date & time, Sign-in & sessions, Numbering, Letterhead & branding, Reports & delivery, Data retention, Features, Billing & IRD and Lab operations. Each tab is saved separately with its own **Save** button.

- **General**: display name, address lines, phones, contact email (for example `info@example.test`), website, receipt footer note and accent colour. Legal name and PAN are set by the LIMS provider.
- **Date & time**: calendar display (A.D., B.S., or both in either order). Timezone is shown as Asia/Kathmandu and cannot be changed. Bills and statutory registers always show both B.S. and A.D.
- **Sign-in & sessions**: idle timeout (15 to 30 minutes), maximum session length (1 to 12 hours), minimum password length (12 to 64), and whether LIMS provider support access only notifies you or needs your approval.
- **Numbering**: prefixes and patterns for patient codes, registration numbers, barcodes, invoices, credit notes, receipts and accession numbers. Each pattern shows a live synthetic example. A pattern change waiting for the next fiscal year is shown read-only with "Takes effect from FY" and the year.
- **Letterhead & branding**: logo, letterhead header and footer (PNG or JPEG, up to 2 MB). A new image is used once its security scan has passed. Choose whether reports and receipts print with letterhead by default.
- **Reports & delivery**: hold reports until paid, partial release, report link validity (30 to 90 days), SMS, WhatsApp and email channels, SMS sender ID.
- **Data retention**: minimum years for clinical records, audit logs and raw analyser messages. Legal periods are not yet confirmed, so these are minimum defaults.
- **Features**: feature switches. Some are managed by the LIMS provider and cannot be changed here.
- **Billing & IRD**: CBMS real-time push, abbreviated invoice limit, and the read-only IRD annex status.
- **Lab operations**: auto-verification (available in Phase 2) and Westgard mode.

## Steps

### Change a setting

1. Open the tab.
2. Change the fields. Invalid values are explained next to the field.
3. Select **Save** on that tab. Other screens pick up the change within 30 seconds.

If another administrator saved the same tab meanwhile, you see "This record was changed by someone else. Reload to see the latest version." Select **Reload**, then repeat your change.

### Change a numbering pattern

Edit the pattern and check the live example before saving. Patterns that would restart numbers mid-year wait for the next fiscal year.

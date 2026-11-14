# Reporting settings

Address: `/reporting/settings`. Permission: `reporting.settings.manage`.

## Purpose

Lab-wide rules for releasing reports and sending them. Only the fields you change are saved. If someone else saved first, you are asked to reload before saving again.

## Fields

- **Release**: auto release when a report is ready (when eligible), or manual release by staff for each report. Narrative reports can be separate or combined with the lab report.
- **Patient mobile channels**: the order tried for patients, and whether email is also used.
- **Referrer**, **centre delivery**, and **critical alert** messages: switch each on or off.
- **Print critical label**: switch on or off.
- **WhatsApp fallback**: minutes to wait (5 to 240) before SMS is tried.
- **Bulk release maximum**: 1 to 200 reports at once.
- **Link reissue limit per day**: 0 to 5.
- **Send a payment link when a report is held for dues**: on by default.
- **Portal payment gateways**: eSewa and Khalti, none by default. Turn on only after online payments are live for your lab.
- **Nominated signatories** (up to 4) and **critical alert recipients** (up to 20).
- **Centre contacts**: shown with masked addresses only.

## Steps: change a setting

1. Change the field.
2. Press Save or `Ctrl+Enter`.
3. If you see a request to reload, someone saved first. Reload, check the new values, and repeat your change.

## Common changes

- Switch to manual release if reports need a second check: set Release to manual.
- A WhatsApp template was rejected: put SMS first in the patient mobile channel order until it is approved.

## Shortcuts

- `Ctrl+Enter`: save the settings.

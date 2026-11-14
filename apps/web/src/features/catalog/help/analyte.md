# Analyte editor (SCR-07)

Route: `/catalog/tests/{test_id}?analyte={analyte_id}` (a drawer inside the test page). Permission to view: `catalog.test.read`; editing needs `catalog.test.manage`.

## Purpose
An analyte is one reported line of a test (for example Haemoglobin). Its display settings change at once; its clinical definition is versioned so past results keep the definition they were reported with.

## Display (not versioned)
Code (pattern `^[A-Z][A-Z0-9_]{0,31}$`, create only), Name (up to 120), Print name (up to 120), Report sub-heading (up to 80), Sort order, Reportable, Active.

## Clinical definition (versioned)
The header shows the version, its status and effective date. Pick an older version to view it read-only. Use "Create new version" when there is no draft, or "Edit draft".
- **Result type**: Numeric · Text · Ordinal · Coded · Attachment · Narrative.
- **Unit**, **Decimals** (0–6), **Method** (printed as METHOD : name), **Value set** (ordinal needs an ordered set).
- **Formula** (numeric only, up to 500 characters). The editor checks it live and lists inputs and calculation order. Use "Try it" to see a sample result. Press `Ctrl+Space` to autocomplete analyte codes and functions.

## Publishing
Publish opens a dialog: Effective from (default Now, not in the past) and a change reason (required, 1–500 characters). Drafts of reference ranges and critical limits are pre-ticked. If the unit or method changed you see "Unit or method changed: the old reference ranges will no longer apply." and must tick the range drafts or "Publish without reference ranges".
Publish needs both `catalog.reference_range.publish` and `catalog.test.manage`; otherwise the button is disabled and its tooltip names the missing permission. Requires two-step verification (lock icon). Press `Ctrl+Enter` to publish from the dialog.

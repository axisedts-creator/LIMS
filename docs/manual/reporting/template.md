# Report template

Address: `/reporting/templates/{template_id}`. Permission: `reporting.template.manage`. Without it the form is read-only.

## Purpose

Edit the draft of a report template. Save the draft, check it with Preview with sample data, then publish it as a new version. New reports use the published version; reports that were already made keep the layout they were made with.

## Fields

- **Page**: size (A4 or Letter) and margins in millimetres.
- **Letterhead**: header and footer images, and the space kept free on plain paper (0 to 80 mm at top and bottom). Images are uploaded in the administration area, not here.
- **Header fields**: which patient and order details appear above the results.
- **Results**: method line, units column, grouping by package, page break before each department, and department approval lines.
- **Signatories**: approving pathologists or nominated signatories, how many (1 to 4), signature images, and the registration label (up to 20 characters).
- **QR code**: on or off, size 15 to 35 mm, caption up to 60 characters.
- **Watermark**: text up to 40 characters (empty means none), opacity 0.05 to 0.3.
- **Disclaimers**: up to five lines of up to 200 characters.
- **Fonts**: base size 7 to 11 pt.

## Steps: edit and publish a version

1. Change the fields you need.
2. Press Save draft. Nothing changes for patients yet.
3. Press Preview with sample data. The preview uses made-up data.
4. Press Publish and read the confirmation: "New reports will use it. Reports already made keep their layout."
5. Confirm. The version number goes up by one.

## Shortcuts

None for this screen. Use Tab and Enter; Esc closes a dialog.

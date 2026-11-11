# Doctors (SCR-11)

Route: `/catalog/doctors`, `/catalog/doctors/{doctor_id}` and the verify queue `/catalog/doctors/verify`. Permission to view: `catalog.referrer.read`; editing needs `catalog.referrer.manage`.

## Purpose
The list of referring doctors. Registration staff can quick-add a doctor; back-office staff verify and clean up the list here.

## List
Columns: Code · Name · Qualification · Verified (badge, "Unverified" until checked) · Source (Back office / Quick add / Import) · Price list · Status. Filter by Verified, Status and Source. Search is sent in the request body, so doctor names are never in the URL (no names in URLs).

## Verify queue
Unverified doctors, newest first, with possible duplicates under each row. Actions: "Verify", "Merge into…", "Edit".

## Fields
Doctor code (optional, auto `DR00001` style), Display name (1–120), Qualification, Registration council (NMC / Other), Registration no., Phone in E.164 format (for example +9779800000000), Email, Notes (up to 500). The price list is shown read-only; assign it in Pricing › Price lists.
Contact fields (phone, email) are hidden for users without `catalog.referrer.manage`.

## Merge
Pick a verified, active target doctor and type the source code to confirm. Past orders keep the original doctor. Reports and analytics will show the target doctor.

## Keys
`/` focus search, `n` new doctor, `Ctrl+S` save, `Esc` close, `?` shortcut help.

# Outsourced reports

Address: `/reporting/outsourced`. Permission to open: `reporting.outsourced.attach`.

## Purpose

Tests sent to an external lab come back as a PDF. Upload the PDF here, check that it belongs to the right patient, and confirm it. Only a confirmed file goes into the report. Every uploaded file is checked for viruses and rebuilt in a safe form before anyone sees it.

## Fields

- **Reg no**, **Patient**, **Test**, **External lab**: which order and test the file is for.
- **File state**: Awaiting file, Checking, Preparing, Awaiting confirmation, Confirmed, Rejected, or Blocked.
- **Upload**: PDF only, up to 15 MB. The external lab name is required (up to 120 characters).
- **Confirm**: tick "I have checked that this report belongs to" the patient, then Confirm. A confirmed file cannot be confirmed again.
- **Search**: registration no. or barcode, the same as on the worklist.

## Steps: attach a returned report

1. Find the row. The state is Awaiting file.
2. Choose Upload and pick the PDF. Type the external lab name.
3. Wait while the state moves through Checking and Preparing. This page refreshes the state for a short time; press Refresh after that.
4. When the state is Awaiting confirmation, open the file and compare the patient details with the order.
5. Tick the check box and press Confirm.

## When a file is not accepted

A Rejected file says why: it is encrypted, damaged, has too many pages, or took too long to check. Ask the external lab for a new copy and upload again. A Blocked file was stopped by the virus scanner; do not open it elsewhere, and tell your lab administrator. If many files are blocked at once, see [runbooks.md](runbooks.md).

## Shortcuts

None for this screen. Use Tab and Enter to move; Esc closes a dialog.

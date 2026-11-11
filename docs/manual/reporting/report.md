# Report

Address: `/reporting/reports/{report_id}`. Permission to open: `reporting.report.read`.

## Purpose

One report for one order. Check the items, the versions, and the deliveries, then release, print, or download it. If the report is held for dues, a banner shows the amount. A user who may record an override can do so from the banner; the release dialog opens again afterwards.

## Fields

- **Items**: each test or package and whether its lab result, narrative, or outsourced file is ready.
- **Versions**: newest first, with the kind (Final, Amended, Addendum), release time, basis, pages, and a Download link. Discarded versions are behind Show discarded.
- **Deliveries**: counts by status and a link to the delivery log filtered to this report.
- **Release**: choose who gets the report. The patient is always included. "Print only" sends no messages.
- **Print**: choose letterhead or plain paper and 1 to 5 copies.
- **More actions**: Regenerate and Revoke QR.

## Steps: release the latest version

1. Check the Items list. Every item should be ready.
2. Press Release or `Alt+R`.
3. Choose the recipients. The patient is always included.
4. Confirm. The delivery counts update; open the log to follow each message.

## Steps: print

1. Press Print or `Alt+P`. The paper dialog opens.
2. Choose letterhead or plain paper and the number of copies (1 to 5).
3. Confirm. Print jobs are shown for a short time and then need a manual Refresh.

A version that is not released yet prints stamped NOT RELEASED, and you need both the print and the release permissions for it.

## Steps: regenerate

Regenerate rebuilds the version that is not yet released. A reason is required. Free text is required when the reason is Other. Released versions are never rebuilt; see the restore runbook in [runbooks.md](runbooks.md).

## Revoke QR

Revoke QR cannot be undone. After it, scanning the printed QR code no longer verifies the report.

## Shortcuts

- `Alt+R`: release the latest version.
- `Alt+P`: print.
- `Alt+D`: download the PDF.

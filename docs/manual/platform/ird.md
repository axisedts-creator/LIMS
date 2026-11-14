# IRD annex tracker

## Purpose

The IRD annex tracker records the status of each tenant's IRD software-registration annexes. Tracking only: the IRD checklist and the Annex 7 template are pending IRD clarification, so the tracker records status and documents and does not submit anything to IRD. Address: `/platform/ird`. Permission: `platform.tenant.read`; changes need `platform.tenant.manage`.

## Columns

One row per tenant and the columns Annex 1 (platform), Annex 2, Annex 3 and Annex 7. Each cell shows the status of that annex.

## Fields

Select a cell to open its record panel:

- Status with the buttons for the allowed next statuses.
- Reference no. (up to 100), Tax office (up to 200), Counterparty for Annex 7 (up to 200), Software version for Annex 1 (up to 40), Submitted on, Completed on, Notes (up to 2000).
- Documents: upload PDF, PNG or JPEG files up to 15 MB, and download them. A new document shows "Scan pending" until its security scan has passed; it cannot be downloaded before then.
- A timeline of all changes.

## Steps

### Record progress

1. Select the tenant's cell for the annex.
2. Fill in the reference number and dates, attach the documents, and select the next status.

### Replace a record

Choose Superseded on the old record. A new successor record opens; fill it in. The old record stays in history.

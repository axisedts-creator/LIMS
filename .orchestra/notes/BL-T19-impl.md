# BL-T19 impl (writer)
Files: worker `jobs/billing/tasks/export_render.ts` (new `buildXlsx`, xlsx branch, feature_disabled throw removed); api `billing/service/export.service.ts` (xlsx guard removed, comment fixed).
[CONV] One sheet; row 1 = header = XML element names (Sn, InvoiceNo, ...); columns = same set/order as the XML row; SN + money = number cells (integer paisa); absent = empty cell.
[CONV] Every text cell incl. header: XML-illegal chars dropped -> shared `neutraliseFormula` -> capped at 32,767 chars (Excel cell limit). No local guard.
[CONV] xlsx general row cap (LIMS_BILLING_EXPORT_MAX_ROWS); on an ifAbsent retry the stored object wins (zip not byte-stable), like PDF.
Open: task brief lists only export.service.ts but the render lives in export_render.ts (edited, same chunk); invoice_documents still feature_disabled (CR-C4-BL15); cancelled-by column absent (CR-C4-BL15); not opened in Excel/LibreOffice.

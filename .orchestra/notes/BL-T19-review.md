APPROVE
# BL-T19 review (reviewer) — diff 5a0c155d..HEAD
- Plan row met: write-excel-file 4.1.1 (already pinned in services/worker/package.json), shared `neutraliseFormula` from packages/shared-ts/spreadsheet on every text cell incl. header (no local guard), `common.feature_disabled` xlsx branch removed in api export.service.ts and worker export_render.ts.
- US-BL-12.1: SalesRow columns = PRD AC1 set/order (SN..Status); SN/money number cells; path `.xlsx`, content type matches API TYPES map. US-BL-12.6: tests cover = + - @ tab CR prefixes.
- Unchanged and still correct: privileged check, access_log, row caps (100k general / 5k PDF), tenant-scoped job SQL, sanitised logs (ids/codes only, no PHI), no secrets. No new names/codes invented.
- Ran: api export.service.test.ts 43/43 pass; worker export.xlsx + export.render 90/90 pass.
- Notes (not blocking): brief lists only export.service.ts but render lives in worker export_render.ts (same chunk); CELL_MAX counts code points, not UTF-16 units (astral-heavy 32k strings could exceed Excel limit — unrealistic for these fields); not opened in Excel/LibreOffice; cancelled-by column + invoice_documents still open under CR-C4-BL15.
